import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { ApiException, type ApiErrorBody } from '@/common/errors/api-exception';
import type { DatabaseTransaction } from '@/database/drizzle';
import type { Payment } from '@/database/schemas/payments.schema';
import type {
  IdempotentRequest,
  StoredResponse,
} from '@/idempotency/idempotency.repository';
import {
  IdempotencyService,
  requestHashOf,
  type IdempotentResponse,
} from '@/idempotency/idempotency.service';
import { PaymentsService } from '@/payments/payments.service';
import type {
  CreatedRefund,
  ProviderErrorKind,
  RefundIdentity,
} from '@/providers/payment-provider.port';
import type { ProviderCode } from '@/providers/provider.constants';
import {
  providerFailureOf,
  type ProviderFailure,
} from '@/providers/provider-failure';
import { ProviderRegistry } from '@/providers/provider.registry';

import type { CreateRefundDto } from './dto/create-refund.dto';
import { CreatedRefundResponseDto } from './dto/created-refund-response.dto';
import { RefundsService, type IngestRefundInput } from './refunds.service';

const API_REFUND_REASON = 'api_refund';
const REFUNDABLE_PAYMENT_STATUSES: readonly Payment['status'][] = [
  'succeeded',
  'partially_refunded',
];

type RefundablePayment = Payment & { providerPaymentId: string };

type RefundReservation = {
  paymentId: string;
  refundId: string;
  refundIdentity: RefundIdentity;
  provider: ProviderCode;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
};

type ProviderOutcome =
  | { isCreated: true; created: CreatedRefund }
  | { isCreated: false; failure: ProviderFailure };

const isRefundable = (payment: Payment): payment is RefundablePayment =>
  REFUNDABLE_PAYMENT_STATUSES.includes(payment.status) &&
  payment.providerPaymentId !== null;

const errorResponseOf = (body: ApiErrorBody): StoredResponse => ({
  statusCode: body.statusCode,
  body,
});

const providerUnavailableResponseOf = (paymentId: string): StoredResponse =>
  errorResponseOf({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: 'provider_unavailable',
    message: 'The payment provider did not confirm the refund',
    paymentId,
  });

// misconfigured is our fault, not the client's: it answers like an outage.
const failureResponseOf = (
  kind: ProviderErrorKind,
  paymentId: string,
): StoredResponse =>
  kind === 'rejected'
    ? errorResponseOf({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'refund_rejected',
        message: 'The payment provider rejected the refund',
      })
    : providerUnavailableResponseOf(paymentId);

const isMissingProviderRefundId = (
  reservation: RefundReservation,
  outcome: ProviderOutcome,
): boolean =>
  outcome.isCreated &&
  reservation.refundIdentity === 'provider' &&
  outcome.created.providerRefundId === null;

const requestOf = (
  idempotencyKey: string,
  paymentId: string,
  dto: CreateRefundDto,
): IdempotentRequest => ({
  scope: 'api:create_refund',
  key: idempotencyKey,
  requestHash: requestHashOf([paymentId, dto.amountMinor]),
});

const ingestInputOf = (
  reservation: RefundReservation,
  created: CreatedRefund,
): IngestRefundInput => ({
  reference: reservation.paymentId,
  provider: reservation.provider,
  providerPaymentId: reservation.providerPaymentId,
  refundReference: reservation.refundId,
  providerRefundId: created.providerRefundId,
  refundIdentity: reservation.refundIdentity,
  status: created.status,
  amountMinor: reservation.amountMinor,
  currency: reservation.currency,
  reason: API_REFUND_REASON,
  webhookEventId: null,
});

@Injectable()
export class RefundCreationService {
  private readonly logger = new Logger(RefundCreationService.name);

  constructor(
    private readonly idempotencyService: IdempotencyService,
    private readonly paymentsService: PaymentsService,
    private readonly refundsService: RefundsService,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  async createRefund(
    idempotencyKey: string,
    paymentId: string,
    dto: CreateRefundDto,
  ): Promise<IdempotentResponse> {
    const normalizedPaymentId = paymentId.toLowerCase();
    const request = requestOf(idempotencyKey, normalizedPaymentId, dto);
    const claim = await this.idempotencyService.claim(request, {
      onClaimed: (tx) =>
        this.reserveRefund(tx, request, normalizedPaymentId, dto.amountMinor),
      // A refund the provider may have made must not be failed by us.
      onInterrupted: (_tx, claimedPaymentId) =>
        Promise.resolve(providerUnavailableResponseOf(claimedPaymentId)),
    });
    if (!claim.isOwner) {
      if (claim.recoveredPaymentId !== null) {
        this.logger.warn(
          `Refund of payment ${claim.recoveredPaymentId}: its request was interrupted before the provider answer was stored`,
        );
      }

      return claim.response;
    }

    const reservation = claim.claimed;
    const outcome = await this.callProvider(reservation);
    const response = await this.idempotencyService.complete(
      request,
      reservation.paymentId,
      (tx) => this.recordOutcome(tx, reservation, outcome),
    );
    this.logOutcome(reservation, outcome);

    return response;
  }

  private async reserveRefund(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
    amountMinor: number,
  ): Promise<RefundReservation> {
    const payment = await this.lockRefundablePayment(tx, paymentId);
    await this.assertAmountAvailable(tx, payment, amountMinor);
    await this.assertNoRefundInProgress(tx, request, payment.id);

    const reservation: RefundReservation = {
      paymentId: payment.id,
      refundId: randomUUID(),
      refundIdentity: this.providerRegistry.refundIdentityOf(payment.provider),
      provider: payment.provider,
      providerPaymentId: payment.providerPaymentId,
      amountMinor,
      currency: payment.currency,
    };
    if (reservation.refundIdentity === 'reference') {
      await this.refundsService.recordApiRefundRequested(tx, {
        refundId: reservation.refundId,
        payment,
        amountMinor,
      });
    }

    return reservation;
  }

  private async lockRefundablePayment(
    tx: DatabaseTransaction,
    paymentId: string,
  ): Promise<RefundablePayment> {
    const payment = await this.paymentsService.lockPayment(tx, paymentId);
    if (!payment) {
      throw new ApiException({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'payment_not_found',
        message: 'Payment not found',
      });
    }
    if (!isRefundable(payment)) {
      throw new ApiException({
        statusCode: HttpStatus.CONFLICT,
        code: 'payment_not_refundable',
        message: 'Only a succeeded or partially refunded payment is refundable',
      });
    }

    return payment;
  }

  private async assertAmountAvailable(
    tx: DatabaseTransaction,
    payment: Payment,
    amountMinor: number,
  ): Promise<void> {
    const reservedMinor = await this.refundsService.sumReservedMinor(
      tx,
      payment.id,
    );
    if (amountMinor <= payment.amountMinor - reservedMinor) return;

    throw new ApiException({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'refund_amount_exceeds_remaining',
      message: 'The refund is larger than the amount left to refund',
    });
  }

  private async assertNoRefundInProgress(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
  ): Promise<void> {
    const isInProgress =
      await this.idempotencyService.hasOtherRequestInProgress(
        tx,
        request,
        paymentId,
      );
    if (!isInProgress) return;

    throw new ApiException({
      statusCode: HttpStatus.CONFLICT,
      code: 'refund_in_progress',
      message: 'Another refund of this payment is still in progress',
    });
  }

  private async callProvider(
    reservation: RefundReservation,
  ): Promise<ProviderOutcome> {
    try {
      const created = await this.providerRegistry
        .get(reservation.provider)
        .refund({
          reference: reservation.refundId,
          providerPaymentId: reservation.providerPaymentId,
          amountMinor: reservation.amountMinor,
          currency: reservation.currency,
        });

      return { isCreated: true, created };
    } catch (error) {
      return { isCreated: false, failure: providerFailureOf(error) };
    }
  }

  private async recordOutcome(
    tx: DatabaseTransaction,
    reservation: RefundReservation,
    outcome: ProviderOutcome,
  ): Promise<StoredResponse> {
    if (!outcome.isCreated) {
      return this.recordFailure(tx, reservation, outcome.failure.kind);
    }
    if (isMissingProviderRefundId(reservation, outcome)) {
      return providerUnavailableResponseOf(reservation.paymentId);
    }

    const { refund } = await this.refundsService.recordApiRefund(
      tx,
      ingestInputOf(reservation, outcome.created),
    );

    return {
      statusCode: HttpStatus.CREATED,
      body: new CreatedRefundResponseDto(refund),
    };
  }

  // unavailable may still have refunded at the provider, so the row stays pending.
  private async recordFailure(
    tx: DatabaseTransaction,
    reservation: RefundReservation,
    kind: ProviderErrorKind,
  ): Promise<StoredResponse> {
    if (reservation.refundIdentity === 'reference' && kind !== 'unavailable') {
      await this.refundsService.recordApiRefundFailed(tx, reservation);
    }

    return failureResponseOf(kind, reservation.paymentId);
  }

  private logOutcome(
    reservation: RefundReservation,
    outcome: ProviderOutcome,
  ): void {
    const subject = `Refund ${reservation.refundId} of payment ${reservation.paymentId} at ${reservation.provider}`;

    if (isMissingProviderRefundId(reservation, outcome)) {
      this.logger.error(`${subject}: the provider returned no refund id`);
      return;
    }
    if (outcome.isCreated) return;

    const message = `${subject} failed: provider_${outcome.failure.kind}: ${outcome.failure.detail}`;
    if (outcome.failure.kind === 'misconfigured') {
      this.logger.error(message);
      return;
    }

    this.logger.warn(message);
  }
}
