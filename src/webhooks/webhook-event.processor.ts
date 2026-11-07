import { Injectable, Logger } from '@nestjs/common';

import {
  describeError,
  isPermanentDataError,
} from '@/database/postgres-errors';
import {
  IngestRejectedError,
  PaymentNotFoundError,
  PaymentsService,
} from '@/payments/payments.service';
import { PAYMENT_STATUS_BY_EVENT_TYPE } from '@/payments/provider-event-status';
import type { ProviderCode } from '@/providers/provider.constants';
import type {
  ProviderEvent,
  ProviderEvents,
  ProviderPaymentEvent,
  ProviderRefundEvent,
} from '@/providers/provider-events';
import { ProviderRegistry } from '@/providers/provider.registry';
import { REFUND_STATUS_BY_EVENT_TYPE } from '@/refunds/refund-event-status';
import {
  RefundPaymentNotFoundError,
  RefundsService,
} from '@/refunds/refunds.service';

import { MAX_FAILURE_REASON_LENGTH, storableText } from './webhook-text';
import type {
  ClaimedWebhookEvent,
  StoredDelivery,
  WebhookEventFinish,
} from './webhooks.repository';

const RETRY_DELAYS_SECONDS = [30, 120, 600, 3600, 21600] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
const MAX_LAST_ERROR_LENGTH = 1000;

type EventResult =
  | { kind: 'handled'; paymentId: string; note: string | null }
  | { kind: 'skipped' }
  | { kind: 'rejected' | 'retryable'; error: string };

const isDomainError = (error: unknown): error is Error =>
  error instanceof IngestRejectedError ||
  error instanceof PaymentNotFoundError ||
  error instanceof RefundPaymentNotFoundError;

const isRejected = (error: unknown): boolean =>
  error instanceof IngestRejectedError || isPermanentDataError(error);

const lastErrorOf = (error: unknown): string =>
  isDomainError(error)
    ? storableText(error.message, MAX_LAST_ERROR_LENGTH)
    : describeError(error);

const failedResultOf = (error: unknown): EventResult => ({
  kind: isRejected(error) ? 'rejected' : 'retryable',
  error: lastErrorOf(error),
});

const paymentIdsOf = (results: readonly EventResult[]): string[] => [
  ...new Set(
    results.flatMap((result) =>
      result.kind === 'handled' ? [result.paymentId] : [],
    ),
  ),
];

const firstErrorOf = (results: readonly EventResult[]): string | null =>
  results.flatMap((result) =>
    result.kind === 'rejected' || result.kind === 'retryable'
      ? [result.error]
      : [],
  )[0] ?? null;

const firstNoteOf = (results: readonly EventResult[]): string | null =>
  results.flatMap((result) =>
    result.kind === 'handled' && result.note !== null ? [result.note] : [],
  )[0] ?? null;

@Injectable()
export class WebhookEventProcessor {
  private readonly logger = new Logger(WebhookEventProcessor.name);

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly paymentsService: PaymentsService,
    private readonly refundsService: RefundsService,
  ) {}

  async process(
    claimed: ClaimedWebhookEvent,
    delivery: StoredDelivery | null,
  ): Promise<WebhookEventFinish> {
    if (claimed.attempts > MAX_ATTEMPTS) {
      return this.fail(claimed, 'Attempts ran out in an interrupted run', []);
    }

    const provider = this.providerRegistry.find(claimed.provider);
    if (!provider) {
      return this.fail(claimed, 'Provider is not registered', []);
    }
    if (!delivery) return this.fail(claimed, 'Delivery has no body', []);

    let events: ProviderEvents;
    try {
      events = provider.parseWebhook(delivery);
    } catch (error) {
      return this.finishOf(claimed, [
        { kind: 'retryable', error: lastErrorOf(error) },
      ]);
    }

    const results: EventResult[] = [];
    for (const event of events) {
      results.push(await this.handle(claimed.id, provider.code, event));
    }

    return this.finishOf(claimed, results);
  }

  private async handle(
    webhookEventId: string,
    providerCode: ProviderCode,
    event: ProviderEvent,
  ): Promise<EventResult> {
    try {
      return await this.apply(webhookEventId, providerCode, event);
    } catch (error) {
      return failedResultOf(error);
    }
  }

  private apply(
    webhookEventId: string,
    providerCode: ProviderCode,
    event: ProviderEvent,
  ): Promise<EventResult> {
    switch (event.type) {
      case 'payment.pending':
      case 'payment.attempt_failed':
      case 'payment.succeeded':
      case 'payment.failed':
      case 'payment.expired':
        return this.applyPayment(webhookEventId, providerCode, event);
      case 'refund.pending':
      case 'refund.succeeded':
      case 'refund.failed':
        return this.applyRefund(webhookEventId, providerCode, event);
      case 'subscription.activated':
      case 'subscription.past_due':
      case 'subscription.paused':
      case 'subscription.canceled':
      case 'subscription.expired':
      case 'unknown':
        return Promise.resolve({ kind: 'skipped' });
      default: {
        const unhandledEvent: never = event;
        throw new Error(`Unhandled event ${String(unhandledEvent)}`);
      }
    }
  }

  private async applyPayment(
    webhookEventId: string,
    providerCode: ProviderCode,
    event: ProviderPaymentEvent,
  ): Promise<EventResult> {
    const { payment } = await this.paymentsService.ingestPayment({
      reference: event.reference,
      provider: providerCode,
      providerPaymentId: event.providerPaymentId,
      status: PAYMENT_STATUS_BY_EVENT_TYPE[event.type],
      amountMinor: event.amountMinor,
      currency: event.currency,
      purpose: event.purpose,
      reason: storableText(
        event.failureReason ?? event.type,
        MAX_FAILURE_REASON_LENGTH,
      ),
      webhookEventId,
    });

    return { kind: 'handled', paymentId: payment.id, note: null };
  }

  private async applyRefund(
    webhookEventId: string,
    providerCode: ProviderCode,
    event: ProviderRefundEvent,
  ): Promise<EventResult> {
    const status = REFUND_STATUS_BY_EVENT_TYPE[event.type];
    const { refund, refundOutcome, payment } =
      await this.refundsService.ingestRefund({
        reference: event.reference,
        provider: providerCode,
        providerPaymentId: event.providerPaymentId,
        refundReference: event.refundReference,
        providerRefundId: event.providerRefundId,
        refundIdentity: this.providerRegistry.refundIdentityOf(providerCode),
        status,
        amountMinor: event.amountMinor,
        currency: event.currency,
        reason: event.type,
        webhookEventId,
      });

    return {
      kind: 'handled',
      paymentId: payment.id,
      note:
        refundOutcome === 'conflict'
          ? `Refund ${refund.id} conflict: ${refund.status} -> ${status}`
          : null,
    };
  }

  private finishOf(
    claimed: ClaimedWebhookEvent,
    results: readonly EventResult[],
  ): WebhookEventFinish {
    const paymentIds = paymentIdsOf(results);
    const firstError = firstErrorOf(results);

    if (firstError !== null) {
      return results.some(({ kind }) => kind === 'retryable')
        ? this.retryOrFail(claimed, firstError, paymentIds)
        : this.fail(claimed, firstError, paymentIds);
    }
    if (paymentIds.length > 0) {
      return {
        status: 'processed',
        lastError: firstNoteOf(results),
        paymentIds,
      };
    }

    return { status: 'ignored', lastError: null, paymentIds };
  }

  private retryOrFail(
    claimed: ClaimedWebhookEvent,
    lastError: string,
    paymentIds: string[],
  ): WebhookEventFinish {
    if (claimed.attempts >= MAX_ATTEMPTS) {
      return this.fail(claimed, lastError, paymentIds);
    }

    const retryDelaySeconds = RETRY_DELAYS_SECONDS[claimed.attempts - 1];
    this.logger.log(
      `Webhook event ${claimed.id} retries in ${retryDelaySeconds} s after attempt ${claimed.attempts}: ${lastError}`,
    );

    return { status: 'received', retryDelaySeconds, lastError, paymentIds };
  }

  private fail(
    claimed: ClaimedWebhookEvent,
    lastError: string,
    paymentIds: string[],
  ): WebhookEventFinish {
    this.logger.warn(
      `Webhook event ${claimed.id} failed at attempt ${claimed.attempts}: ${lastError}`,
    );

    return { status: 'failed', lastError, paymentIds };
  }
}

export { MAX_ATTEMPTS, RETRY_DELAYS_SECONDS };
