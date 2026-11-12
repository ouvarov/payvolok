import { RECONCILE_LEASE_SECONDS } from '@/payments/payment.constants';
import { PADDLE_REQUEST_TIMEOUT_MS } from '@/providers/paddle/paddle-http';

import {
  ingestableStatusOf,
  nextReconcileAfterOf,
  type ScheduleInput,
} from './reconciliation-schedule';
import {
  PENDING_RECONCILE_DELAYS_SECONDS,
  REFUNDABLE_RECONCILE_DELAY_SECONDS,
} from './reconciliation.constants';

const NOW = new Date('2026-11-12T12:00:00.000Z');

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

const createdAgo = (seconds: number): Date =>
  new Date(NOW.getTime() - seconds * 1000);

const scheduleWith = (
  overrides: Partial<ScheduleInput> = {},
): ScheduleInput => ({
  status: 'pending',
  createdAt: createdAgo(HOUR_SECONDS),
  now: NOW,
  ...overrides,
});

const secondsUntil = (next: Date | null): number | null =>
  next === null ? null : (next.getTime() - NOW.getTime()) / 1000;

describe('ingestableStatusOf', () => {
  it.each([
    ['pending', 'pending'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['expired', 'expired'],
    ['partially_refunded', 'succeeded'],
    ['refunded', 'succeeded'],
  ] as const)('maps %s to %s', (providerStatus, ingestableStatus) => {
    expect(ingestableStatusOf(providerStatus)).toBe(ingestableStatus);
  });
});

describe('nextReconcileAfterOf', () => {
  it.each([
    [30, 300],
    [600, 300],
    [900, 900],
    [1799, 900],
    [1800, 1800],
    [HOUR_SECONDS, 3600],
    [2 * HOUR_SECONDS, 3600],
    [3 * HOUR_SECONDS, 10800],
    [6 * HOUR_SECONDS, 21600],
    [DAY_SECONDS, 86400],
    [5 * DAY_SECONDS, 86400],
  ])(
    'backs a pending payment %i seconds old off by %i seconds',
    (ageSeconds, delaySeconds) => {
      expect(
        secondsUntil(
          nextReconcileAfterOf(
            scheduleWith({ createdAt: createdAgo(ageSeconds) }),
          ),
        ),
      ).toBe(delaySeconds);
    },
  );

  it('backs a created payment off like a pending one', () => {
    expect(
      secondsUntil(
        nextReconcileAfterOf(
          scheduleWith({ status: 'created', createdAt: createdAgo(1800) }),
        ),
      ),
    ).toBe(1800);
  });

  it.each(['succeeded', 'partially_refunded'] as const)(
    'checks a %s payment daily',
    (status) => {
      expect(secondsUntil(nextReconcileAfterOf(scheduleWith({ status })))).toBe(
        REFUNDABLE_RECONCILE_DELAY_SECONDS,
      );
    },
  );

  it.each(['refunded', 'failed', 'expired'] as const)(
    'stops for a %s payment',
    (status) => {
      expect(nextReconcileAfterOf(scheduleWith({ status }))).toBeNull();
    },
  );

  it('stops when the next check would fall past 30 days from creation', () => {
    expect(
      nextReconcileAfterOf(
        scheduleWith({ createdAt: createdAgo(29.9 * DAY_SECONDS) }),
      ),
    ).toBeNull();
  });

  it('keeps checking when the next check is still inside the window', () => {
    expect(
      secondsUntil(
        nextReconcileAfterOf(
          scheduleWith({ createdAt: createdAgo(28.9 * DAY_SECONDS) }),
        ),
      ),
    ).toBe(86400);
  });
});

describe('reconcile lease', () => {
  it('is shorter than the shortest backoff, so a finished check is told apart from a leased one', () => {
    expect(Math.min(...PENDING_RECONCILE_DELAYS_SECONDS)).toBeGreaterThan(
      RECONCILE_LEASE_SECONDS,
    );
  });

  it('outlasts two Paddle requests with room to spare', () => {
    expect(PADDLE_REQUEST_TIMEOUT_MS * 2).toBeLessThan(
      (RECONCILE_LEASE_SECONDS * 1000) / 2,
    );
  });
});
