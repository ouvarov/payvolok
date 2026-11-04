import type { TransitionDecision } from '@/payments/payment-state-machine';

import type { RefundStatus } from './refund.constants';
import {
  decideRefundTransition,
  paymentStatusAfterRefunds,
} from './refund-state-machine';

describe('decideRefundTransition', () => {
  it.each<[RefundStatus, RefundStatus, TransitionDecision]>([
    ['pending', 'pending', 'duplicate'],
    ['pending', 'succeeded', 'apply'],
    ['pending', 'failed', 'apply'],
    ['succeeded', 'pending', 'stale'],
    ['succeeded', 'succeeded', 'duplicate'],
    ['succeeded', 'failed', 'conflict'],
    ['failed', 'pending', 'stale'],
    ['failed', 'succeeded', 'conflict'],
    ['failed', 'failed', 'duplicate'],
  ])('decides %s -> %s as %s', (from, to, decision) => {
    expect(decideRefundTransition(from, to)).toBe(decision);
  });
});

describe('paymentStatusAfterRefunds', () => {
  it.each([
    [0, 1000, null],
    [1, 1000, 'partially_refunded'],
    [999, 1000, 'partially_refunded'],
    [1000, 1000, 'refunded'],
    [1001, 1000, 'refunded'],
    [0, 0, null],
    [1, 0, 'refunded'],
  ])('maps %s refunded of %s to %s', (refunded, amount, status) => {
    expect(paymentStatusAfterRefunds(refunded, amount)).toBe(status);
  });
});
