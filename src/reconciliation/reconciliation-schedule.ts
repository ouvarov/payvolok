import type { PaymentStatus } from '@/payments/payment.constants';
import type { IngestablePaymentStatus } from '@/payments/provider-event-status';
import type { ProviderPaymentStatus } from '@/providers/payment-provider.port';

import {
  PENDING_RECONCILE_DELAYS_SECONDS,
  RECONCILE_WINDOW_MS,
  REFUNDABLE_RECONCILE_DELAY_SECONDS,
} from './reconciliation.constants';

type ScheduleInput = {
  status: PaymentStatus;
  createdAt: Date;
  now: Date;
};

// Refund rows come only from refund ingest, so a refunded payment is ingested
// as succeeded and its refund status follows from the refunds.
const INGESTABLE_STATUS_BY_PROVIDER_STATUS = {
  pending: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
  expired: 'expired',
  partially_refunded: 'succeeded',
  refunded: 'succeeded',
} as const satisfies Record<ProviderPaymentStatus, IngestablePaymentStatus>;

// By age, not by attempts: checks a GET brings forward must not stretch the backoff.
const pendingDelaySecondsOf = (ageSeconds: number): number =>
  PENDING_RECONCILE_DELAYS_SECONDS.findLast(
    (delaySeconds) => delaySeconds <= ageSeconds,
  ) ?? PENDING_RECONCILE_DELAYS_SECONDS[0];

const RECONCILE_DELAY_SECONDS_BY_STATUS: Record<
  PaymentStatus,
  ((ageSeconds: number) => number) | null
> = {
  created: pendingDelaySecondsOf,
  pending: pendingDelaySecondsOf,
  succeeded: () => REFUNDABLE_RECONCILE_DELAY_SECONDS,
  partially_refunded: () => REFUNDABLE_RECONCILE_DELAY_SECONDS,
  refunded: null,
  failed: null,
  expired: null,
};

const ingestableStatusOf = (
  status: ProviderPaymentStatus,
): IngestablePaymentStatus => INGESTABLE_STATUS_BY_PROVIDER_STATUS[status];

const nextReconcileAfterOf = ({
  status,
  createdAt,
  now,
}: ScheduleInput): Date | null => {
  const delaySecondsOf = RECONCILE_DELAY_SECONDS_BY_STATUS[status];
  if (!delaySecondsOf) return null;

  const ageSeconds = (now.getTime() - createdAt.getTime()) / 1000;
  const nextEpochMs = now.getTime() + delaySecondsOf(ageSeconds) * 1000;
  if (nextEpochMs > createdAt.getTime() + RECONCILE_WINDOW_MS) return null;

  return new Date(nextEpochMs);
};

export { ingestableStatusOf, nextReconcileAfterOf };
export type { ScheduleInput };
