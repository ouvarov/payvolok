import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { CURRENCY_PATTERN } from '@/common/currency';
import { ApiException } from '@/common/errors/api-exception';
import type { DatabaseTransaction } from '@/database/drizzle';
import { describeError, isUniqueViolationOf } from '@/database/postgres-errors';
import type { Payment } from '@/database/schemas/payments.schema';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import type { CreatedPayment } from '@/providers/payment-provider.port';
import type { ProviderCode } from '@/providers/provider.constants';

import { PaymentResponseDto } from './dto/payment-response.dto';
import {
  PAYMENTS_ACCOUNT_PROVIDER_REF_UNIQUE,
  PAYMENTS_PROVIDER_REF_UNIQUE,
  type PaymentPurpose,
  type PaymentStatus,
} from './payment.constants';
import { decideTransition } from './payment-state-machine';
import { PaymentsRepository } from './payments.repository';
import type { IngestablePaymentStatus } from './provider-event-status';

const paymentReferenceSchema = z.uuid();

const API_REQUEST_REASON = 'api_request';
const PROVIDER_CREATED_REASON = 'provider_created';
const REQUEST_INTERRUPTED_REASON = 'request_interrupted';
const PROVIDER_REF_UNIQUES = [
  PAYMENTS_PROVIDER_REF_UNIQUE,
  PAYMENTS_ACCOUNT_PROVIDER_REF_UNIQUE,
];

type RequestedPaymentInput = {
  projectId: string;
  providerAccountId: string;
  provider: ProviderCode;
  amountMinor: number;
  currency: string;
};

type ApiPaymentRef = { paymentId: string; provider: ProviderCode };

type IngestPaymentInput = {
  reference: string | null;
  provider: ProviderCode;
  providerAccountId: string | null;
  providerPaymentId: string;
  status: IngestablePaymentStatus;
  amountMinor: number;
  currency: string;
  purpose: PaymentPurpose;
  reason: string;
  webhookEventId: string | null;
};

type IngestPaymentResult = {
  payment: Payment;
  outcome: 'created' | 'applied' | 'duplicate' | 'stale' | 'conflict';
};

type PaymentLookup = Pick<
  IngestPaymentInput,
  'reference' | 'provider' | 'providerPaymentId'
>;

type ApplyStatusInput = {
  payment: Payment;
  targetStatus: PaymentStatus;
  reason: string;
  webhookEventId: string | null;
};

export class IngestRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IngestRejectedError';
  }
}

export class PaymentEventInvalidError extends IngestRejectedError {
  readonly field: 'amountMinor' | 'currency' | 'providerPaymentId';

  constructor(field: 'amountMinor' | 'currency' | 'providerPaymentId') {
    super(`Payment event has an invalid ${field}`);
    this.name = 'PaymentEventInvalidError';
    this.field = field;
  }
}

export class PaymentMismatchError extends IngestRejectedError {
  readonly paymentId: string;
  readonly storedAmountMinor: number;
  readonly storedCurrency: string;
  readonly receivedAmountMinor: number;
  readonly receivedCurrency: string;

  constructor(
    stored: Pick<Payment, 'id' | 'amountMinor' | 'currency'>,
    received: Pick<IngestPaymentInput, 'amountMinor' | 'currency'>,
  ) {
    super(
      `Payment ${stored.id} mismatch: stored ${stored.amountMinor} ${stored.currency}, received ${received.amountMinor} ${received.currency}`,
    );
    this.name = 'PaymentMismatchError';
    this.paymentId = stored.id;
    this.storedAmountMinor = stored.amountMinor;
    this.storedCurrency = stored.currency;
    this.receivedAmountMinor = received.amountMinor;
    this.receivedCurrency = received.currency;
  }
}

export class PaymentProviderRefMismatchError extends IngestRejectedError {
  readonly paymentId: string;
  readonly storedProviderPaymentId: string | null;
  readonly receivedProviderPaymentId: string;

  constructor(
    stored: Pick<Payment, 'id' | 'providerPaymentId'>,
    received: Pick<IngestPaymentInput, 'providerPaymentId'>,
  ) {
    super(
      `Payment ${stored.id} provider ref mismatch: stored ${stored.providerPaymentId}, received ${received.providerPaymentId}`,
    );
    this.name = 'PaymentProviderRefMismatchError';
    this.paymentId = stored.id;
    this.storedProviderPaymentId = stored.providerPaymentId;
    this.receivedProviderPaymentId = received.providerPaymentId;
  }
}

export class PaymentProviderRefOwnedError extends IngestRejectedError {
  readonly reference: string | null;
  readonly providerPaymentId: string;

  constructor(received: PaymentLookup, options?: ErrorOptions) {
    super(
      `Payment ${received.reference} cannot take provider ref ${received.providerPaymentId}: another payment owns it`,
      options,
    );
    this.name = 'PaymentProviderRefOwnedError';
    this.reference = received.reference;
    this.providerPaymentId = received.providerPaymentId;
  }
}

// Not an IngestRejectedError: our row may not be committed yet, so the worker retries.
export class PaymentNotFoundError extends Error {
  readonly reference: string | null;
  readonly providerPaymentId: string;

  constructor(received: PaymentLookup) {
    super(
      `No payment for reference ${received.reference} or provider ref ${received.providerPaymentId} yet`,
    );
    this.name = 'PaymentNotFoundError';
    this.reference = received.reference;
    this.providerPaymentId = received.providerPaymentId;
  }
}

const assertValidPaymentEvent = (
  input: Pick<
    IngestPaymentInput,
    'amountMinor' | 'currency' | 'providerPaymentId'
  >,
): void => {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new PaymentEventInvalidError('amountMinor');
  }
  if (!CURRENCY_PATTERN.test(input.currency)) {
    throw new PaymentEventInvalidError('currency');
  }
  if (input.providerPaymentId === '') {
    throw new PaymentEventInvalidError('providerPaymentId');
  }
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly paymentsRepository: PaymentsRepository) {}

  async getPayment(paymentId: string): Promise<PaymentResponseDto> {
    const payment = await this.paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new ApiException({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'payment_not_found',
        message: 'Payment not found',
      });
    }
    if (payment.status === 'created' || payment.status === 'pending') {
      await this.requestReconciliation(payment.id);
    }

    return new PaymentResponseDto(payment);
  }

  async recordRequested(
    tx: DatabaseTransaction,
    input: RequestedPaymentInput,
  ): Promise<Payment> {
    const payment = await this.paymentsRepository.insertIfAbsent(tx, {
      projectId: input.projectId,
      providerAccountId: input.providerAccountId,
      provider: input.provider,
      providerPaymentId: null,
      purpose: 'one_off',
      origin: 'api',
      status: 'created',
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
    if (!payment) throw new Error('Payment insert returned no row');

    await this.paymentsRepository.insertEvent(tx, {
      paymentId: payment.id,
      fromStatus: null,
      toStatus: 'created',
      outcome: 'applied',
      reason: API_REQUEST_REASON,
      webhookEventId: null,
    });

    return payment;
  }

  // A webhook may have moved the row first: the link is then a no-op and an
  // older status is recorded as stale.
  async recordCreated(
    tx: DatabaseTransaction,
    ref: ApiPaymentRef,
    created: CreatedPayment,
  ): Promise<IngestPaymentResult> {
    const payment = await this.lockApiPayment(tx, ref);
    const linkedPayment = await this.linkProviderPaymentId(tx, payment, {
      reference: payment.id,
      provider: ref.provider,
      providerPaymentId: created.providerPaymentId,
    });

    return this.applyApiStatus(
      tx,
      linkedPayment,
      created.status,
      PROVIDER_CREATED_REASON,
    );
  }

  async recordFailed(
    tx: DatabaseTransaction,
    ref: ApiPaymentRef,
    reason: string,
  ): Promise<IngestPaymentResult> {
    const payment = await this.lockApiPayment(tx, ref);
    // A webhook already reported the provider's status, which our own failure
    // signal must not override: failed is terminal and would block a later succeeded.
    if (payment.status !== 'created' && payment.status !== 'failed') {
      return this.recordStaleFailure(tx, payment, reason);
    }

    return this.applyApiStatus(tx, payment, 'failed', reason);
  }

  recordInterrupted(
    tx: DatabaseTransaction,
    ref: ApiPaymentRef,
  ): Promise<IngestPaymentResult> {
    return this.recordFailed(tx, ref, REQUEST_INTERRUPTED_REASON);
  }

  async ingestPayment(input: IngestPaymentInput): Promise<IngestPaymentResult> {
    assertValidPaymentEvent(input);

    const result = await this.runIngestTransaction(input, (tx) =>
      this.ingestInTransaction(tx, input),
    );

    if (result.outcome === 'conflict') {
      this.logger.warn(
        `Payment ${result.payment.id} conflict: ${result.payment.status} -> ${input.status}`,
      );
    }

    return result;
  }

  async runIngestTransaction<T>(
    received: PaymentLookup,
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.paymentsRepository.withTransaction(work);
    } catch (error) {
      if (
        PROVIDER_REF_UNIQUES.some((name) => isUniqueViolationOf(error, name))
      ) {
        throw new PaymentProviderRefOwnedError(received, { cause: error });
      }

      throw error;
    }
  }

  scheduleReconciliation(
    tx: DatabaseTransaction,
    paymentId: string,
    delaySeconds: number,
  ): Promise<void> {
    return this.paymentsRepository.scheduleReconciliation(
      tx,
      paymentId,
      delaySeconds,
    );
  }

  lockPayment(
    tx: DatabaseTransaction,
    paymentId: string,
  ): Promise<Payment | null> {
    return this.paymentsRepository.findByIdForUpdate(tx, paymentId);
  }

  async lockPaymentForRefund(
    tx: DatabaseTransaction,
    lookup: PaymentLookup,
  ): Promise<Payment | null> {
    const referencedPayment = await this.findReferencedPayment(tx, lookup);
    if (referencedPayment) {
      return this.linkProviderPaymentId(tx, referencedPayment, lookup);
    }

    return this.paymentsRepository.findByProviderRefForUpdate(
      tx,
      lookup.provider,
      lookup.providerPaymentId,
    );
  }

  // Best effort: the read already succeeded, so a failed nudge only delays the next check.
  private async requestReconciliation(paymentId: string): Promise<void> {
    try {
      await this.paymentsRepository.requestReconciliation(paymentId);
    } catch (error) {
      this.logger.warn(
        `Payment ${paymentId} reconciliation request failed: ${describeError(error)}`,
      );
    }
  }

  private async ingestInTransaction(
    tx: DatabaseTransaction,
    input: IngestPaymentInput,
  ): Promise<IngestPaymentResult> {
    const referencedPayment = await this.findReferencedPayment(tx, input);
    if (referencedPayment) {
      const linkedPayment = await this.linkProviderPaymentId(
        tx,
        referencedPayment,
        input,
      );

      return this.applyToExisting(tx, linkedPayment, input);
    }

    const createdPayment =
      input.purpose === 'subscription_renewal'
        ? await this.birthPayment(tx, input)
        : null;
    if (createdPayment) return { payment: createdPayment, outcome: 'created' };

    const existingPayment =
      await this.paymentsRepository.findByProviderRefForUpdate(
        tx,
        input.provider,
        input.providerPaymentId,
      );
    if (!existingPayment) throw new PaymentNotFoundError(input);

    return this.applyToExisting(tx, existingPayment, input);
  }

  private async lockApiPayment(
    tx: DatabaseTransaction,
    ref: ApiPaymentRef,
  ): Promise<Payment> {
    const payment = await this.paymentsRepository.findByIdAndProviderForUpdate(
      tx,
      ref.paymentId,
      ref.provider,
    );
    if (!payment) throw new Error(`Payment ${ref.paymentId} disappeared`);

    return payment;
  }

  private async recordStaleFailure(
    tx: DatabaseTransaction,
    payment: Payment,
    reason: string,
  ): Promise<IngestPaymentResult> {
    await this.paymentsRepository.insertEvent(tx, {
      paymentId: payment.id,
      fromStatus: payment.status,
      toStatus: 'failed',
      outcome: 'stale',
      reason,
      webhookEventId: null,
    });

    return { payment, outcome: 'stale' };
  }

  private async applyApiStatus(
    tx: DatabaseTransaction,
    payment: Payment,
    targetStatus: PaymentStatus,
    reason: string,
  ): Promise<IngestPaymentResult> {
    const result = await this.applyStatusInTransaction(tx, {
      payment,
      targetStatus,
      reason,
      webhookEventId: null,
    });

    if (result.outcome === 'conflict') {
      this.logger.warn(
        `Payment ${payment.id} conflict: ${payment.status} -> ${targetStatus}`,
      );
    }

    return result;
  }

  private async birthPayment(
    tx: DatabaseTransaction,
    input: IngestPaymentInput,
  ): Promise<Payment | null> {
    const createdPayment = await this.paymentsRepository.insertIfAbsent(tx, {
      projectId: SEED_PROJECT_ID,
      providerAccountId: input.providerAccountId,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      purpose: input.purpose,
      origin: 'provider',
      status: input.status,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
    if (!createdPayment) return null;

    await this.paymentsRepository.insertEvent(tx, {
      paymentId: createdPayment.id,
      fromStatus: null,
      toStatus: input.status,
      outcome: 'applied',
      reason: input.reason,
      webhookEventId: input.webhookEventId,
    });

    return createdPayment;
  }

  private async findReferencedPayment(
    tx: DatabaseTransaction,
    input: PaymentLookup,
  ): Promise<Payment | null> {
    if (input.reference === null) return null;

    const reference = paymentReferenceSchema.safeParse(input.reference);
    if (!reference.success) return null;

    return this.paymentsRepository.findByIdAndProviderForUpdate(
      tx,
      reference.data,
      input.provider,
    );
  }

  private async linkProviderPaymentId(
    tx: DatabaseTransaction,
    payment: Payment,
    input: PaymentLookup,
  ): Promise<Payment> {
    if (payment.providerPaymentId === input.providerPaymentId) return payment;

    if (payment.providerPaymentId !== null) {
      throw new PaymentProviderRefMismatchError(payment, input);
    }

    const linkedPayment = await this.paymentsRepository.setProviderPaymentId(
      tx,
      payment.id,
      input.providerPaymentId,
    );

    if (!linkedPayment) {
      throw new Error('Payment row disappeared during ingest');
    }

    return linkedPayment;
  }

  private async applyToExisting(
    tx: DatabaseTransaction,
    existingPayment: Payment,
    input: IngestPaymentInput,
  ): Promise<IngestPaymentResult> {
    if (
      existingPayment.amountMinor !== input.amountMinor ||
      existingPayment.currency !== input.currency
    ) {
      throw new PaymentMismatchError(existingPayment, input);
    }

    return this.applyStatusInTransaction(tx, {
      payment: existingPayment,
      targetStatus: input.status,
      reason: input.reason,
      webhookEventId: input.webhookEventId,
    });
  }

  // The caller must already hold the row lock on the payment.
  async applyStatusInTransaction(
    tx: DatabaseTransaction,
    { payment, targetStatus, reason, webhookEventId }: ApplyStatusInput,
  ): Promise<IngestPaymentResult> {
    const decision = decideTransition(payment.status, targetStatus);

    if (decision === 'duplicate') {
      return { payment, outcome: 'duplicate' };
    }

    const currentPayment =
      decision === 'apply'
        ? await this.paymentsRepository.updateStatus(
            tx,
            payment.id,
            targetStatus,
          )
        : payment;

    if (!currentPayment) {
      throw new Error('Payment row disappeared during ingest');
    }

    const outcome = decision === 'apply' ? 'applied' : decision;

    await this.paymentsRepository.insertEvent(tx, {
      paymentId: payment.id,
      fromStatus: payment.status,
      toStatus: targetStatus,
      outcome,
      reason,
      webhookEventId,
    });

    return { payment: currentPayment, outcome };
  }
}

export type {
  ApiPaymentRef,
  IngestPaymentInput,
  IngestPaymentResult,
  PaymentLookup,
  RequestedPaymentInput,
};
