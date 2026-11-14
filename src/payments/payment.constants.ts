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

const PAYMENT_ORIGINS = ['api', 'admin', 'demo', 'provider'] as const;

const PAYMENT_EVENT_OUTCOMES = ['applied', 'stale', 'conflict'] as const;

const RECONCILABLE_PAYMENT_STATUSES = [
  'created',
  'pending',
  'succeeded',
  'partially_refunded',
] as const satisfies readonly PaymentStatus[];

const NUDGEABLE_PAYMENT_STATUSES = [
  'created',
  'pending',
] as const satisfies readonly PaymentStatus[];

const RECONCILE_GRACE_SECONDS = 600;
const RECONCILE_LEASE_SECONDS = 120;
const RECONCILE_NUDGE_MIN_AGE_SECONDS = 30;
const RECONCILE_NUDGE_THROTTLE_SECONDS = 15;
const RECONCILIATION_INTERRUPTED_REASON = 'reconciliation_interrupted';

const PAYMENTS_PROVIDER_REF_UNIQUE =
  'payments_provider_provider_payment_id_unique';
const PAYMENTS_ACCOUNT_PROVIDER_REF_UNIQUE =
  'payments_provider_account_id_provider_payment_id_unique';

type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];
type PaymentOrigin = (typeof PAYMENT_ORIGINS)[number];
type PaymentEventOutcome = (typeof PAYMENT_EVENT_OUTCOMES)[number];

export {
  NUDGEABLE_PAYMENT_STATUSES,
  PAYMENT_EVENT_OUTCOMES,
  PAYMENT_ORIGINS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  PAYMENTS_ACCOUNT_PROVIDER_REF_UNIQUE,
  PAYMENTS_PROVIDER_REF_UNIQUE,
  RECONCILABLE_PAYMENT_STATUSES,
  RECONCILE_GRACE_SECONDS,
  RECONCILE_LEASE_SECONDS,
  RECONCILE_NUDGE_MIN_AGE_SECONDS,
  RECONCILE_NUDGE_THROTTLE_SECONDS,
  RECONCILIATION_INTERRUPTED_REASON,
};
export type {
  PaymentEventOutcome,
  PaymentOrigin,
  PaymentPurpose,
  PaymentStatus,
};
