import type { PaymentStatus } from './payment.constants';

type TransitionDecision = 'apply' | 'duplicate' | 'stale' | 'conflict';

// Forward skips are deliberate: a lost `pending` must not block `succeeded`,
// and a refund arriving before `succeeded` must still converge on `refunded`.
const FORWARD_STATUSES: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: [
    'pending',
    'succeeded',
    'failed',
    'expired',
    'partially_refunded',
    'refunded',
  ],
  pending: ['succeeded', 'failed', 'expired', 'partially_refunded', 'refunded'],
  succeeded: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
  failed: [],
  expired: [],
};

const decideTransition = (
  from: PaymentStatus,
  to: PaymentStatus,
): TransitionDecision => {
  if (from === to) return 'duplicate';
  if (FORWARD_STATUSES[from].includes(to)) return 'apply';
  if (FORWARD_STATUSES[to].includes(from)) return 'stale';
  return 'conflict';
};

export { decideTransition };
export type { TransitionDecision };
