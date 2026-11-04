import { PAYMENT_STATUSES, type PaymentStatus } from './payment.constants';
import {
  decideTransition,
  type TransitionDecision,
} from './payment-state-machine';

const EXPECTED_DECISIONS: Record<
  PaymentStatus,
  Record<PaymentStatus, TransitionDecision>
> = {
  created: {
    created: 'duplicate',
    pending: 'apply',
    succeeded: 'apply',
    partially_refunded: 'apply',
    refunded: 'apply',
    failed: 'apply',
    expired: 'apply',
  },
  pending: {
    created: 'stale',
    pending: 'duplicate',
    succeeded: 'apply',
    partially_refunded: 'apply',
    refunded: 'apply',
    failed: 'apply',
    expired: 'apply',
  },
  succeeded: {
    created: 'stale',
    pending: 'stale',
    succeeded: 'duplicate',
    partially_refunded: 'apply',
    refunded: 'apply',
    failed: 'conflict',
    expired: 'conflict',
  },
  partially_refunded: {
    created: 'stale',
    pending: 'stale',
    succeeded: 'stale',
    partially_refunded: 'duplicate',
    refunded: 'apply',
    failed: 'conflict',
    expired: 'conflict',
  },
  refunded: {
    created: 'stale',
    pending: 'stale',
    succeeded: 'stale',
    partially_refunded: 'stale',
    refunded: 'duplicate',
    failed: 'conflict',
    expired: 'conflict',
  },
  failed: {
    created: 'stale',
    pending: 'stale',
    succeeded: 'conflict',
    partially_refunded: 'conflict',
    refunded: 'conflict',
    failed: 'duplicate',
    expired: 'conflict',
  },
  expired: {
    created: 'stale',
    pending: 'stale',
    succeeded: 'conflict',
    partially_refunded: 'conflict',
    refunded: 'conflict',
    failed: 'conflict',
    expired: 'duplicate',
  },
};

const ALL_PAIRS = PAYMENT_STATUSES.flatMap((from) =>
  PAYMENT_STATUSES.map((to): [PaymentStatus, PaymentStatus] => [from, to]),
);

const permutationsOf = <T>(items: readonly T[]): T[][] => {
  if (items.length <= 1) return [[...items]];

  return items.flatMap((item, index) =>
    permutationsOf(items.toSpliced(index, 1)).map((rest) => [item, ...rest]),
  );
};

const foldTransitions = (
  start: PaymentStatus,
  arrivals: readonly PaymentStatus[],
): PaymentStatus =>
  arrivals.reduce(
    (current, next) =>
      decideTransition(current, next) === 'apply' ? next : current,
    start,
  );

describe('decideTransition', () => {
  it('covers all 49 status pairs', () => {
    expect(ALL_PAIRS).toHaveLength(49);
  });

  it.each(ALL_PAIRS)('decides %s -> %s from the table', (from, to) => {
    expect(decideTransition(from, to)).toBe(EXPECTED_DECISIONS[from][to]);
  });

  it.each(
    ALL_PAIRS.filter(([from, to]) => EXPECTED_DECISIONS[to][from] === 'apply'),
  )('never moves backwards from %s to %s', (from, to) => {
    expect(decideTransition(from, to)).toBe('stale');
  });

  it('ends at refunded for every arrival order of the refund path', () => {
    const arrivalOrders = permutationsOf<PaymentStatus>([
      'pending',
      'succeeded',
      'partially_refunded',
      'refunded',
    ]);

    expect(arrivalOrders).toHaveLength(24);
    arrivalOrders.forEach((arrivals) => {
      expect(foldTransitions('created', arrivals)).toBe('refunded');
    });
  });
});
