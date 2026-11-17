import { Injectable, Logger } from '@nestjs/common';

import {
  MAX_FAILURE_REASON_LENGTH,
  storableText,
} from '@/common/storable-text';
import {
  describeError,
  isPermanentDataError,
} from '@/database/postgres-errors';
import {
  ForeignAccountError,
  IngestRejectedError,
  PaymentNotFoundError,
  PaymentsService,
} from '@/payments/payments.service';
import { PAYMENT_STATUS_BY_EVENT_TYPE } from '@/payments/provider-event-status';
import { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import { accountLabelOf } from '@/providers/bound-provider';
import type { BoundProvider } from '@/providers/payment-provider.port';
import type {
  ProviderEvent,
  ProviderEvents,
  ProviderPaymentEvent,
  ProviderRefundEvent,
} from '@/providers/provider-events';
import { REFUND_STATUS_BY_EVENT_TYPE } from '@/refunds/refund-event-status';
import {
  RefundPaymentNotFoundError,
  RefundsService,
} from '@/refunds/refunds.service';

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
  | { kind: 'skipped'; note: string | null }
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

const SKIPPED: EventResult = { kind: 'skipped', note: null };

const failedResultOf = (error: unknown): EventResult => {
  if (error instanceof ForeignAccountError) {
    return {
      kind: 'skipped',
      note: storableText(error.message, MAX_LAST_ERROR_LENGTH),
    };
  }

  return {
    kind: isRejected(error) ? 'rejected' : 'retryable',
    error: lastErrorOf(error),
  };
};

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
    (result.kind === 'handled' || result.kind === 'skipped') &&
    result.note !== null
      ? [result.note]
      : [],
  )[0] ?? null;

@Injectable()
export class WebhookEventProcessor {
  private readonly logger = new Logger(WebhookEventProcessor.name);

  constructor(
    private readonly providerAccountsService: ProviderAccountsService,
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

    if (!delivery) return this.fail(claimed, 'Delivery has no body', []);

    let provider: BoundProvider;
    try {
      provider = await this.providerAccountsService.bind(
        claimed.providerAccountId,
      );
    } catch (error) {
      return this.finishOf(claimed, [
        { kind: 'retryable', error: lastErrorOf(error) },
      ]);
    }

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
      results.push(await this.handle(claimed, provider, event));
    }

    return this.finishOf(claimed, results);
  }

  private async handle(
    claimed: ClaimedWebhookEvent,
    provider: BoundProvider,
    event: ProviderEvent,
  ): Promise<EventResult> {
    try {
      return await this.apply(claimed, provider, event);
    } catch (error) {
      if (error instanceof ForeignAccountError) {
        this.warnForeignAccount(claimed, provider, error);
      }
      return failedResultOf(error);
    }
  }

  // A signed event naming another account's payment means a misrouted destination or a shared secret.
  private warnForeignAccount(
    claimed: ClaimedWebhookEvent,
    provider: BoundProvider,
    error: ForeignAccountError,
  ): void {
    this.logger.warn(
      `Webhook event ${claimed.id} on ${accountLabelOf(provider)} ignored: ${error.message}, account ${error.ownerAccountId ?? 'none'}`,
    );
  }

  private apply(
    claimed: ClaimedWebhookEvent,
    provider: BoundProvider,
    event: ProviderEvent,
  ): Promise<EventResult> {
    switch (event.type) {
      case 'payment.pending':
      case 'payment.attempt_failed':
      case 'payment.succeeded':
      case 'payment.failed':
      case 'payment.expired':
        return this.applyPayment(claimed.id, provider, event);
      case 'refund.pending':
      case 'refund.succeeded':
      case 'refund.failed':
        return this.applyRefund(claimed.id, provider, event);
      case 'subscription.activated':
      case 'subscription.past_due':
      case 'subscription.paused':
      case 'subscription.canceled':
      case 'subscription.expired':
      case 'unknown':
        return Promise.resolve(SKIPPED);
      default: {
        const unhandledEvent: never = event;
        throw new Error(`Unhandled event ${String(unhandledEvent)}`);
      }
    }
  }

  private async applyPayment(
    webhookEventId: string,
    provider: BoundProvider,
    event: ProviderPaymentEvent,
  ): Promise<EventResult> {
    const status = PAYMENT_STATUS_BY_EVENT_TYPE[event.type];
    const { payment, outcome } = await this.paymentsService.ingestPayment({
      reference: event.reference,
      provider: provider.code,
      projectId: provider.projectId,
      providerAccountId: provider.accountId,
      providerPaymentId: event.providerPaymentId,
      status,
      amountMinor: event.amountMinor,
      currency: event.currency,
      purpose: event.purpose,
      reason: storableText(
        event.failureReason ?? event.type,
        MAX_FAILURE_REASON_LENGTH,
      ),
      webhookEventId,
    });

    return {
      kind: 'handled',
      paymentId: payment.id,
      note:
        outcome === 'conflict'
          ? `Payment ${payment.id} conflict: ${payment.status} -> ${status}`
          : null,
    };
  }

  private async applyRefund(
    webhookEventId: string,
    provider: BoundProvider,
    event: ProviderRefundEvent,
  ): Promise<EventResult> {
    const status = REFUND_STATUS_BY_EVENT_TYPE[event.type];
    const { refund, refundOutcome, payment } =
      await this.refundsService.ingestRefund({
        reference: event.reference,
        provider: provider.code,
        providerAccountId: provider.accountId,
        providerPaymentId: event.providerPaymentId,
        refundReference: event.refundReference,
        providerRefundId: event.providerRefundId,
        refundIdentity: provider.capabilities.refundIdentity,
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

    return { status: 'ignored', lastError: firstNoteOf(results), paymentIds };
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

export { MAX_ATTEMPTS };
