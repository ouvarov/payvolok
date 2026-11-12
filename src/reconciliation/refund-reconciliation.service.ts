import { Injectable, Logger } from '@nestjs/common';

import type { Refund } from '@/database/schemas/refunds.schema';
import type { PaymentStatus } from '@/payments/payment.constants';
import { IngestRejectedError } from '@/payments/payments.service';
import type {
  PaymentProvider,
  ProviderRefundRecord,
  RefundIdentity,
} from '@/providers/payment-provider.port';
import {
  providerFailureOf,
  type ProviderFailure,
} from '@/providers/provider-failure';
import type { ProviderCode } from '@/providers/provider.constants';
import {
  RefundsService,
  type IngestRefundInput,
  type IngestRefundResult,
} from '@/refunds/refunds.service';

import { RECONCILIATION_REASON } from './reconciliation.constants';

type RefundablePayment = {
  id: string;
  provider: ProviderCode;
  providerPaymentId: string;
};

type RefundCheck =
  | {
      isAnswered: true;
      isChanged: boolean;
      paymentStatus: PaymentStatus | null;
    }
  | { isAnswered: false; failure: ProviderFailure };

type ProviderAnswer<Value> =
  | { isAnswered: true; value: Value }
  | { isAnswered: false; failure: ProviderFailure };

type ProviderRefund = Omit<ProviderRefundRecord, 'providerRefundId'> & {
  providerRefundId: string | null;
};

type Unanswered = Extract<ProviderAnswer<unknown>, { isAnswered: false }>;

const UNCHANGED: RefundCheck = {
  isAnswered: true,
  isChanged: false,
  paymentStatus: null,
};

const askProvider = async <Value>(
  call: () => Promise<Value>,
): Promise<ProviderAnswer<Value>> => {
  try {
    return { isAnswered: true, value: await call() };
  } catch (error) {
    return { isAnswered: false, failure: providerFailureOf(error) };
  }
};

const refundInputOf = (
  payment: RefundablePayment,
  refundIdentity: RefundIdentity,
  refundReference: string | null,
  providerRefund: ProviderRefund,
): IngestRefundInput => ({
  reference: payment.id,
  provider: payment.provider,
  providerPaymentId: payment.providerPaymentId,
  refundReference,
  providerRefundId: providerRefund.providerRefundId,
  refundIdentity,
  status: providerRefund.status,
  amountMinor: providerRefund.amountMinor,
  currency: providerRefund.currency,
  reason: RECONCILIATION_REASON,
  webhookEventId: null,
});

const isChangedBy = ({
  refundOutcome,
  paymentOutcome,
}: IngestRefundResult): boolean =>
  refundOutcome === 'created' ||
  refundOutcome === 'applied' ||
  paymentOutcome === 'applied';

const refundCheckOf = (
  ingested: readonly IngestRefundResult[],
): RefundCheck => ({
  isAnswered: true,
  isChanged: ingested.some(isChangedBy),
  paymentStatus: ingested.at(-1)?.payment.status ?? null,
});

@Injectable()
export class RefundReconciliationService {
  private readonly logger = new Logger(RefundReconciliationService.name);

  constructor(private readonly refundsService: RefundsService) {}

  // The adapter comes from the caller, which owns the one way to resolve it.
  reconcile(
    provider: PaymentProvider,
    payment: RefundablePayment,
  ): Promise<RefundCheck> {
    return provider.capabilities.refundIdentity === 'provider'
      ? this.reconcileListed(provider, payment)
      : this.reconcilePending(provider, payment);
  }

  // A refund whose POST timed out exists only at the provider, so its list is the source.
  private async reconcileListed(
    provider: PaymentProvider,
    payment: RefundablePayment,
  ): Promise<RefundCheck> {
    const answer = await askProvider(() =>
      provider.listRefunds(payment.providerPaymentId),
    );
    if (!answer.isAnswered) return this.unansweredCheckOf(payment, answer);

    const ingested: IngestRefundResult[] = [];
    for (const record of answer.value) {
      const result = await this.ingest(
        payment,
        refundInputOf(payment, 'provider', null, record),
      );
      if (result) ingested.push(result);
    }

    return refundCheckOf(ingested);
  }

  // Our own pending rows carry the reference the provider knows them by.
  private async reconcilePending(
    provider: PaymentProvider,
    payment: RefundablePayment,
  ): Promise<RefundCheck> {
    const pendingRefunds = await this.refundsService.findPendingRefunds(
      payment.id,
    );

    const ingested: IngestRefundResult[] = [];
    for (const refund of pendingRefunds) {
      const answer = await this.askRefundStatus(provider, payment, refund);
      if (!answer.isAnswered) {
        const check = this.unansweredCheckOf(payment, answer);
        if (!check.isAnswered) return check;
        continue;
      }
      if (!answer.value) continue;

      const result = await this.ingest(
        payment,
        refundInputOf(payment, 'reference', refund.id, answer.value),
      );
      if (result) ingested.push(result);
    }

    return refundCheckOf(ingested);
  }

  private async askRefundStatus(
    provider: PaymentProvider,
    payment: RefundablePayment,
    refund: Refund,
  ): Promise<ProviderAnswer<ProviderRefund | null>> {
    const answer = await askProvider(() =>
      provider.getStatus({
        resource: 'refund',
        providerPaymentId: payment.providerPaymentId,
        providerRefundId: refund.providerRefundId,
        reference: refund.id,
      }),
    );
    if (!answer.isAnswered) return answer;

    const status = answer.value;
    if (status === null) {
      this.logger.warn(
        `Refund ${refund.id} of payment ${payment.id} is unknown to ${payment.provider}; left pending`,
      );
      return { isAnswered: true, value: null };
    }
    if (status.resource !== 'refund') {
      this.logger.error(
        `Refund ${refund.id} of payment ${payment.id}: ${payment.provider} answered with a ${status.resource}`,
      );
      return { isAnswered: true, value: null };
    }

    return { isAnswered: true, value: status };
  }

  private unansweredCheckOf(
    payment: RefundablePayment,
    { failure }: Unanswered,
  ): RefundCheck {
    if (failure.kind !== 'rejected') return { isAnswered: false, failure };

    this.logger.error(
      `Refunds of payment ${payment.id} were rejected by ${payment.provider}: ${failure.detail}`,
    );
    return UNCHANGED;
  }

  private async ingest(
    payment: RefundablePayment,
    input: IngestRefundInput,
  ): Promise<IngestRefundResult | null> {
    try {
      const result = await this.refundsService.ingestRefund(input);
      this.logResult(payment, result);

      return result;
    } catch (error) {
      if (!(error instanceof IngestRejectedError)) throw error;

      this.logger.error(
        `Refund ${input.providerRefundId ?? input.refundReference} of payment ${payment.id} was not reconciled: ${error.message}`,
      );
      return null;
    }
  }

  private logResult(
    payment: RefundablePayment,
    {
      refund,
      refundOutcome,
      payment: current,
      paymentOutcome,
    }: IngestRefundResult,
  ): void {
    if (refundOutcome === 'created') {
      this.logger.warn(
        `Refund ${refund.id} (${refund.providerRefundId}) of payment ${payment.id} found only at the provider ${payment.provider}; recorded ${refund.status}`,
      );
    } else if (refundOutcome === 'applied') {
      this.logger.log(
        `Refund ${refund.id} of payment ${payment.id} reconciled: now ${refund.status}`,
      );
    }
    if (paymentOutcome === 'applied') {
      this.logger.log(
        `Payment ${payment.id} reconciled from its refunds: now ${current.status}`,
      );
    }
  }
}

export type { RefundablePayment, RefundCheck };
