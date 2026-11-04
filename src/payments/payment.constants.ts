const PAYMENT_STATUSES = [
  'created',
  'pending',
  'succeeded',
  'partially_refunded',
  'refunded',
  'failed',
  'expired',
] as const;

const PAYMENT_PURPOSES = [
  'one_off',
  'subscription_initial',
  'subscription_renewal',
] as const;

const PAYMENT_ORIGINS = ['api', 'admin', 'demo'] as const;

const PAYMENT_EVENT_OUTCOMES = ['applied', 'stale', 'conflict'] as const;

type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];
type PaymentOrigin = (typeof PAYMENT_ORIGINS)[number];
type PaymentEventOutcome = (typeof PAYMENT_EVENT_OUTCOMES)[number];

export {
  PAYMENT_EVENT_OUTCOMES,
  PAYMENT_ORIGINS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
};
export type {
  PaymentEventOutcome,
  PaymentOrigin,
  PaymentPurpose,
  PaymentStatus,
};
