const IDEMPOTENCY_SCOPES = ['api:create_payment', 'api:create_refund'] as const;

const IDEMPOTENCY_KEY_STATUSES = ['in_progress', 'completed'] as const;

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

const IDEMPOTENCY_LEASE_SECONDS = 60;
const IDEMPOTENCY_KEY_TTL_HOURS = 24;
const IDEMPOTENCY_KEY_TTL_SECONDS = IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60;

type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[number];
type IdempotencyKeyStatus = (typeof IDEMPOTENCY_KEY_STATUSES)[number];

export {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_KEY_STATUSES,
  IDEMPOTENCY_KEY_TTL_HOURS,
  IDEMPOTENCY_KEY_TTL_SECONDS,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_SCOPES,
  IDEMPOTENT_REPLAYED_HEADER,
};
export type { IdempotencyKeyStatus, IdempotencyScope };
