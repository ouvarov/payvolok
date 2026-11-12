import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { CURRENCY_PATTERN } from '@/common/currency';
import type { DatabaseTransaction } from '@/database/drizzle';
import { isUniqueViolationOf } from '@/database/postgres-errors';
import type { Payment } from '@/database/schemas/payments.schema';
import type { Refund } from '@/database/schemas/refunds.schema';
import type { PaymentOrigin } from '@/payments/payment.constants';
import type { TransitionDecision } from '@/payments/payment-state-machine';
import {
  IngestRejectedError,
  PaymentsService,
  type IngestPaymentResult,
} from '@/payments/payments.service';
import type { RefundIdentity } from '@/providers/payment-provider.port';
import type { ProviderCode } from '@/providers/provider.constants';

import {
  REFUNDS_PROVIDER_REF_UNIQUE,
  type RefundStatus,
} from './refund.constants';
import {
  decideRefundTransition,
  paymentStatusAfterRefunds,
} from './refund-state-machine';
import { RefundsRepository } from './refunds.repository';

const refundReferenceSchema = z.uuid();

type IngestRefundInput = {
  reference: string | null;
  provider: ProviderCode;
  providerPaymentId: string;
  refundReference: string | null;
  providerRefundId: string | null;
  refundIdentity: RefundIdentity;
  status: RefundStatus;
  amountMinor: number;
  currency: string;
  reason: string;
  webhookEventId: string | null;
};

type RefundOrigin = Extract<PaymentOrigin, 'api' | 'provider'>;

type RequestedApiRefund = {
  refundId: string;
  payment: Pick<Payment, 'id' | 'provider' | 'currency'>;
  amountMinor: number;
};

type ApiRefundRef = { paymentId: string; refundId: string };

type RefundOutcome =
  'created' | 'applied' | Exclude<TransitionDecision, 'apply'>;

type IngestRefundResult = {
  refund: Refund;
  refundOutcome: RefundOutcome;
  payment: Payment;
  paymentOutcome: IngestPaymentResult['outcome'] | 'unchanged';
  refundedTotalMinor: number;
};

export class RefundEventInvalidError extends IngestRejectedError {
  constructor(problem: string) {
    super(`Refund event is invalid: ${problem}`);
    this.name = 'RefundEventInvalidError';
  }
}

export class RefundMismatchError extends IngestRejectedError {
  readonly paymentId: string | null;

  constructor(
    paymentId: string | null,
    problem: string,
    options?: ErrorOptions,
  ) {
    super(`Refund mismatch: ${problem}`, options);
    this.name = 'RefundMismatchError';
    this.paymentId = paymentId;
  }
}

// Not an IngestRejectedError: the payment event may still arrive, so the worker retries.
export class RefundPaymentNotFoundError extends Error {
  readonly providerPaymentId: string;

  constructor(providerPaymentId: string) {
    super(`No payment for provider ref ${providerPaymentId} yet`);
    this.name = 'RefundPaymentNotFoundError';
    this.providerPaymentId = providerPaymentId;
  }
}

const refundIdOf = (refundReference: string | null): string | null => {
  const parsed = refundReferenceSchema.safeParse(refundReference);

  return parsed.success ? parsed.data.toLowerCase() : null;
};

const hasRefundIdentity = (input: IngestRefundInput): boolean =>
  input.refundIdentity === 'provider'
    ? input.providerRefundId !== null
    : refundIdOf(input.refundReference) !== null;

const assertValidRefundEvent = (input: IngestRefundInput): void => {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new RefundEventInvalidError('amountMinor');
  }
  if (!CURRENCY_PATTERN.test(input.currency)) {
    throw new RefundEventInvalidError('currency');
  }
  if (input.providerPaymentId === '') {
    throw new RefundEventInvalidError('empty providerPaymentId');
  }
  if (input.providerRefundId === '') {
    throw new RefundEventInvalidError('empty providerRefundId');
  }
  // The id refundIdentity names is the only key every event of one refund carries;
  // without it a later event could make a second row and count the money again.
  // A non-uuid reference can never be a refunds.id, so it does not count as one.
  if (!hasRefundIdentity(input)) {
    throw new RefundEventInvalidError(`no ${input.refundIdentity} refund id`);
  }
};

const mismatchProblemOf = (
  refund: Refund,
  payment: Payment,
  input: IngestRefundInput,
): string | null => {
  if (refund.paymentId !== payment.id) {
    return `refund ${refund.id} belongs to another payment`;
  }
  if (
    refund.amountMinor !== input.amountMinor ||
    refund.currency !== input.currency
  ) {
    return `refund ${refund.id} stored ${refund.amountMinor} ${refund.currency}, received ${input.amountMinor} ${input.currency}`;
  }
  if (
    input.providerRefundId !== null &&
    refund.providerRefundId !== null &&
    input.providerRefundId !== refund.providerRefundId
  ) {
    return `refund ${refund.id} stored provider ref ${refund.providerRefundId}, received ${input.providerRefundId}`;
  }

  return null;
};

const didRefundBecomeSucceeded = (
  refund: Refund,
  refundOutcome: RefundOutcome,
): boolean =>
  refund.status === 'succeeded' &&
  (refundOutcome === 'created' || refundOutcome === 'applied');

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly refundsRepository: RefundsRepository,
  ) {}

  async ingestRefund(input: IngestRefundInput): Promise<IngestRefundResult> {
    assertValidRefundEvent(input);

    const result = await this.runTransaction(input);
    this.warnAboutResult(result, input);

    return result;
  }

  // Runs in the caller's transaction, which already holds the idempotency key.
  async recordApiRefund(
    tx: DatabaseTransaction,
    input: IngestRefundInput,
  ): Promise<IngestRefundResult> {
    assertValidRefundEvent(input);

    const result = await this.ingestInTransaction(tx, input, 'api');
    this.warnAboutResult(result, input);

    return result;
  }

  async recordApiRefundRequested(
    tx: DatabaseTransaction,
    requested: RequestedApiRefund,
  ): Promise<Refund> {
    const refund = await this.refundsRepository.insertIfAbsent(tx, {
      id: requested.refundId,
      paymentId: requested.payment.id,
      provider: requested.payment.provider,
      providerRefundId: null,
      origin: 'api',
      status: 'pending',
      amountMinor: requested.amountMinor,
      currency: requested.payment.currency,
    });
    if (!refund) throw new Error(`Refund ${requested.refundId} already exists`);

    return refund;
  }

  // Only our own untouched pending row fails: a status or id the provider
  // already reported wins over our failure signal, as for payments.
  async recordApiRefundFailed(
    tx: DatabaseTransaction,
    ref: ApiRefundRef,
  ): Promise<void> {
    const payment = await this.paymentsService.lockPayment(tx, ref.paymentId);
    if (!payment) throw new Error(`Payment ${ref.paymentId} disappeared`);

    const refund = await this.refundsRepository.findByIdAndPayment(
      tx,
      ref.refundId,
      payment.id,
    );
    if (!refund) throw new Error(`Refund ${ref.refundId} disappeared`);

    if (refund.status !== 'pending' || refund.providerRefundId !== null) {
      this.logger.warn(
        `Refund ${refund.id} keeps ${refund.status}: the provider reported it before the call failed`,
      );
      return;
    }

    await this.refundsRepository.updateStatus(tx, refund.id, 'failed');
  }

  sumReservedMinor(
    tx: DatabaseTransaction,
    paymentId: string,
  ): Promise<number> {
    return this.refundsRepository.sumReservedMinor(tx, paymentId);
  }

  findPendingRefunds(paymentId: string): Promise<Refund[]> {
    return this.refundsRepository.findPendingByPayment(paymentId);
  }

  private async runTransaction(
    input: IngestRefundInput,
  ): Promise<IngestRefundResult> {
    try {
      return await this.paymentsService.runIngestTransaction(input, (tx) =>
        this.ingestInTransaction(tx, input, 'provider'),
      );
    } catch (error) {
      if (isUniqueViolationOf(error, REFUNDS_PROVIDER_REF_UNIQUE)) {
        throw new RefundMismatchError(
          null,
          `provider ref ${input.providerRefundId} is owned by another refund`,
          { cause: error },
        );
      }

      throw error;
    }
  }

  private async ingestInTransaction(
    tx: DatabaseTransaction,
    input: IngestRefundInput,
    origin: RefundOrigin,
  ): Promise<IngestRefundResult> {
    const payment = await this.paymentsService.lockPaymentForRefund(tx, input);
    if (!payment) throw new RefundPaymentNotFoundError(input.providerPaymentId);

    if (input.currency !== payment.currency) {
      throw new RefundMismatchError(
        payment.id,
        `payment ${payment.id} is in ${payment.currency}, received ${input.currency}`,
      );
    }

    const { refund, refundOutcome } = await this.upsertRefund(
      tx,
      payment,
      input,
      origin,
    );
    const refundedTotalMinor = await this.refundsRepository.sumSucceededMinor(
      tx,
      payment.id,
    );
    const targetStatus = didRefundBecomeSucceeded(refund, refundOutcome)
      ? paymentStatusAfterRefunds(refundedTotalMinor, payment.amountMinor)
      : null;
    const paymentResult: Pick<
      IngestRefundResult,
      'payment' | 'paymentOutcome'
    > = targetStatus
      ? await this.applyPaymentStatus(tx, payment, targetStatus, input)
      : { payment, paymentOutcome: 'unchanged' };

    return { refund, refundOutcome, refundedTotalMinor, ...paymentResult };
  }

  private async applyPaymentStatus(
    tx: DatabaseTransaction,
    payment: Payment,
    targetStatus: 'partially_refunded' | 'refunded',
    input: IngestRefundInput,
  ): Promise<Pick<IngestRefundResult, 'payment' | 'paymentOutcome'>> {
    const { payment: currentPayment, outcome } =
      await this.paymentsService.applyStatusInTransaction(tx, {
        payment,
        targetStatus,
        reason: input.reason,
        webhookEventId: input.webhookEventId,
      });

    return { payment: currentPayment, paymentOutcome: outcome };
  }

  private async upsertRefund(
    tx: DatabaseTransaction,
    payment: Payment,
    input: IngestRefundInput,
    origin: RefundOrigin,
  ): Promise<Pick<IngestRefundResult, 'refund' | 'refundOutcome'>> {
    const existingRefund = await this.findRefund(tx, payment, input);
    if (!existingRefund) return this.insertRefund(tx, payment, input, origin);

    const problem = mismatchProblemOf(existingRefund, payment, input);
    if (problem) throw new RefundMismatchError(payment.id, problem);
    await this.assertReferenceNotOwnedElsewhere(tx, existingRefund, input);

    const linkedRefund = await this.linkProviderRefundId(
      tx,
      existingRefund,
      input,
    );
    const decision = decideRefundTransition(linkedRefund.status, input.status);
    if (decision !== 'apply') {
      return { refund: linkedRefund, refundOutcome: decision };
    }

    const updatedRefund = await this.refundsRepository.updateStatus(
      tx,
      linkedRefund.id,
      input.status,
    );
    if (!updatedRefund) throw new Error('Refund row disappeared during ingest');

    return { refund: updatedRefund, refundOutcome: 'applied' };
  }

  // A reference no row owns is ignored: the provider id already identified the refund.
  private async assertReferenceNotOwnedElsewhere(
    tx: DatabaseTransaction,
    refund: Refund,
    input: IngestRefundInput,
  ): Promise<void> {
    const refundId = refundIdOf(input.refundReference);
    if (refundId === null || refundId === refund.id) return;

    const owner = await this.refundsRepository.findById(tx, refundId);
    if (!owner) return;

    throw new RefundMismatchError(
      refund.paymentId,
      `refund ${refund.id} received reference of refund ${owner.id}`,
    );
  }

  private async findRefund(
    tx: DatabaseTransaction,
    payment: Payment,
    input: IngestRefundInput,
  ): Promise<Refund | null> {
    const refundId = refundIdOf(input.refundReference);
    const referencedRefund = refundId
      ? await this.refundsRepository.findByIdAndPayment(
          tx,
          refundId,
          payment.id,
        )
      : null;
    if (referencedRefund) return referencedRefund;
    if (input.providerRefundId === null) return null;

    return this.refundsRepository.findByProviderRef(
      tx,
      input.provider,
      input.providerRefundId,
    );
  }

  private async insertRefund(
    tx: DatabaseTransaction,
    payment: Payment,
    input: IngestRefundInput,
    origin: RefundOrigin,
  ): Promise<Pick<IngestRefundResult, 'refund' | 'refundOutcome'>> {
    const refundId = refundIdOf(input.refundReference);
    // The reference becomes the row id so a reference-only redelivery finds this row.
    const refund = await this.refundsRepository.insertIfAbsent(tx, {
      ...(refundId ? { id: refundId } : {}),
      paymentId: payment.id,
      provider: input.provider,
      providerRefundId: input.providerRefundId,
      origin,
      status: input.status,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
    if (refund) return { refund, refundOutcome: 'created' };

    const owner = await this.findConflictingRefund(tx, refundId, input);
    if (!owner) throw new Error('Refund row disappeared during ingest');

    throw new RefundMismatchError(
      payment.id,
      `refund ${owner.id} of payment ${owner.paymentId} owns the received id`,
    );
  }

  private async findConflictingRefund(
    tx: DatabaseTransaction,
    refundId: string | null,
    input: IngestRefundInput,
  ): Promise<Refund | null> {
    const refundById = refundId
      ? await this.refundsRepository.findById(tx, refundId)
      : null;
    if (refundById || input.providerRefundId === null) return refundById;

    return this.refundsRepository.findByProviderRef(
      tx,
      input.provider,
      input.providerRefundId,
    );
  }

  private async linkProviderRefundId(
    tx: DatabaseTransaction,
    refund: Refund,
    input: IngestRefundInput,
  ): Promise<Refund> {
    if (input.providerRefundId === null || refund.providerRefundId !== null) {
      return refund;
    }

    const linkedRefund = await this.refundsRepository.setProviderRefundId(
      tx,
      refund.id,
      input.providerRefundId,
    );
    if (!linkedRefund) throw new Error('Refund row disappeared during ingest');

    return linkedRefund;
  }

  private warnAboutResult(
    result: IngestRefundResult,
    input: IngestRefundInput,
  ): void {
    const { refund, refundOutcome, payment, paymentOutcome } = result;

    if (refundOutcome === 'conflict') {
      this.logger.warn(
        `Refund ${refund.id} conflict: ${refund.status} -> ${input.status}`,
      );
    }
    if (paymentOutcome === 'conflict') {
      this.logger.warn(
        `Payment ${payment.id} conflict: refund ${refund.id} on a ${payment.status} payment`,
      );
    }
    if (
      didRefundBecomeSucceeded(refund, refundOutcome) &&
      result.refundedTotalMinor > payment.amountMinor
    ) {
      this.logger.warn(
        `Payment ${payment.id} over-refunded: ${result.refundedTotalMinor} of ${payment.amountMinor} ${payment.currency}`,
      );
    }
  }
}

export type {
  ApiRefundRef,
  IngestRefundInput,
  IngestRefundResult,
  RequestedApiRefund,
};
