import type { TransitionDecision } from '@/payments/payment-state-machine';

import type { RefundStatus } from './refund.constants';

const decideRefundTransition = (
  from: RefundStatus,
  to: RefundStatus,
): TransitionDecision => {
  if (from === to) return 'duplicate';
  if (from === 'pending') return 'apply';
  if (to === 'pending') return 'stale';
  return 'conflict';
};

const paymentStatusAfterRefunds = (
  refundedTotalMinor: number,
  paymentAmountMinor: number,
): 'partially_refunded' | 'refunded' | null => {
  if (refundedTotalMinor === 0) return null;

  return refundedTotalMinor < paymentAmountMinor
    ? 'partially_refunded'
    : 'refunded';
};

export { decideRefundTransition, paymentStatusAfterRefunds };
