import { createHash } from 'node:crypto';

type ProviderEventBase = {
  dedupKey: string;
  // An ISO-8601 string, not a Date, so the event stays JSON-safe in inbox storage.
  occurredAt: string | null;
};

type ProviderPaymentEvent = ProviderEventBase & {
  type:
    | 'payment.pending'
    | 'payment.attempt_failed'
    | 'payment.succeeded'
    | 'payment.failed'
    | 'payment.expired';
  reference: string | null;
  providerPaymentId: string;
  providerSubscriptionId: string | null;
  amountMinor: number;
  currency: string;
  failureReason: string | null;
};

// An adapter must give every event of one refund the same stable key.
type ProviderRefundEvent = ProviderEventBase & {
  type: 'refund.pending' | 'refund.succeeded' | 'refund.failed';
  providerPaymentId: string;
  reference: string | null;
  refundReference: string | null;
  providerRefundId: string | null;
  amountMinor: number;
  currency: string;
};

type ProviderSubscriptionEvent = ProviderEventBase & {
  type:
    | 'subscription.activated'
    | 'subscription.past_due'
    | 'subscription.paused'
    | 'subscription.canceled'
    | 'subscription.expired';
  reference: string | null;
  providerSubscriptionId: string;
  providerStatus: string;
  currentPeriodEnd: string | null;
};

type ProviderUnknownEvent = ProviderEventBase & {
  type: 'unknown';
  rawType: string | null;
};

type ProviderEvent =
  | ProviderPaymentEvent
  | ProviderRefundEvent
  | ProviderSubscriptionEvent
  | ProviderUnknownEvent;

type ProviderEvents = readonly [ProviderEvent, ...ProviderEvent[]];

const dedupKeyFromBody = (rawBody: Buffer): string =>
  `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;

export { dedupKeyFromBody };
export type {
  ProviderEvent,
  ProviderEvents,
  ProviderPaymentEvent,
  ProviderRefundEvent,
  ProviderSubscriptionEvent,
  ProviderUnknownEvent,
};
