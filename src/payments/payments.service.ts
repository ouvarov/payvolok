import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { DatabaseTransaction } from '@/database/drizzle';
import { isUniqueViolationOf } from '@/database/postgres-errors';
import type { Payment } from '@/database/schemas/payments.schema';
import type { ProviderCode } from '@/providers/provider.constants';

import {
  CURRENCY_PATTERN,
  PAYMENTS_PROVIDER_REF_UNIQUE,
  type PaymentOrigin,
  type PaymentPurpose,
  type PaymentStatus,
} from './payment.constants';
import { decideTransition } from './payment-state-machine';
import { PaymentsRepository } from './payments.repository';

const paymentReferenceSchema = z.uuid();

type IngestPaymentInput = {
  reference: string | null;
  provider: ProviderCode;
  providerPaymentId: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  purpose: PaymentPurpose;
  origin: PaymentOrigin;
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

export class IngestRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IngestRejectedError';
  }
}

export class PaymentEventInvalidError extends IngestRejectedError {
  readonly field: 'amountMinor' | 'currency';

  constructor(field: 'amountMinor' | 'currency') {
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

const assertValidPaymentEvent = (
  input: Pick<IngestPaymentInput, 'amountMinor' | 'currency'>,
): void => {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new PaymentEventInvalidError('amountMinor');
  }
  if (!CURRENCY_PATTERN.test(input.currency)) {
    throw new PaymentEventInvalidError('currency');
  }
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly paymentsRepository: PaymentsRepository) {}

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
      if (isUniqueViolationOf(error, PAYMENTS_PROVIDER_REF_UNIQUE)) {
        throw new PaymentProviderRefOwnedError(received, { cause: error });
      }

      throw error;
    }
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

    const createdPayment = await this.paymentsRepository.insertIfAbsent(tx, {
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      purpose: input.purpose,
      origin: input.origin,
      status: input.status,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });

    if (createdPayment) {
      await this.paymentsRepository.insertEvent(tx, {
        paymentId: createdPayment.id,
        fromStatus: null,
        toStatus: input.status,
        outcome: 'applied',
        reason: input.reason,
        webhookEventId: input.webhookEventId,
      });

      return { payment: createdPayment, outcome: 'created' };
    }

    const existingPayment =
      await this.paymentsRepository.findByProviderRefForUpdate(
        tx,
        input.provider,
        input.providerPaymentId,
      );

    if (!existingPayment) {
      throw new Error('Payment row disappeared during ingest');
    }

    return this.applyToExisting(tx, existingPayment, input);
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

    return this.applyStatusInTransaction(
      tx,
      existingPayment,
      input.status,
      input.reason,
      input.webhookEventId,
    );
  }

  // The caller must already hold the row lock on existingPayment.
  async applyStatusInTransaction(
    tx: DatabaseTransaction,
    existingPayment: Payment,
    targetStatus: PaymentStatus,
    reason: string,
    webhookEventId: string | null,
  ): Promise<IngestPaymentResult> {
    const decision = decideTransition(existingPayment.status, targetStatus);

    if (decision === 'duplicate') {
      return { payment: existingPayment, outcome: 'duplicate' };
    }

    const currentPayment =
      decision === 'apply'
        ? await this.paymentsRepository.updateStatus(
            tx,
            existingPayment.id,
            targetStatus,
          )
        : existingPayment;

    if (!currentPayment) {
      throw new Error('Payment row disappeared during ingest');
    }

    const outcome = decision === 'apply' ? 'applied' : decision;

    await this.paymentsRepository.insertEvent(tx, {
      paymentId: existingPayment.id,
      fromStatus: existingPayment.status,
      toStatus: targetStatus,
      outcome,
      reason,
      webhookEventId,
    });

    return { payment: currentPayment, outcome };
  }
}

export type { IngestPaymentInput, IngestPaymentResult, PaymentLookup };
