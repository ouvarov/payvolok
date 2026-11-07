import { createHash } from 'node:crypto';

type ProviderEventBase = {
  dedupKey: string;
  // An ISO-8601 string, not a Date, so the event stays JSON-safe in inbox storage.
  occurredAt: string | null;
};

// Only a provider's explicit renewal marker may say subscription_renewal: that value births a row.
type ProviderPaymentPurpose =
  'one_off' | 'subscription_initial' | 'subscription_renewal';

type ProviderPaymentEvent = ProviderEventBase & {
  type:
    | 'payment.pending'
    | 'payment.attempt_failed'
    | 'payment.succeeded'
    | 'payment.failed'
    | 'payment.expired';
  purpose: ProviderPaymentPurpose;
  reference: string | null;
  providerPaymentId: string;
  providerSubscriptionId: string | null;
  amountMinor: number;
  currency: string;
  failureReason: string | null;
};

// dedupKey differs per step; the id the provider's refundIdentity names is on every event of one refund.
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
  ProviderPaymentPurpose,
  ProviderRefundEvent,
  ProviderSubscriptionEvent,
  ProviderUnknownEvent,
};
