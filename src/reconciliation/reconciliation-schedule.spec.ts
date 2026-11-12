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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-12T12:00:00.000Z');

const scheduleWith = (
  overrides: Partial<ScheduleInput> = {},
): ScheduleInput => ({
  status: 'pending',
  attempts: 1,
  createdAt: new Date(NOW.getTime() - 60 * 1000),
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
  it.each(
    PENDING_RECONCILE_DELAYS_SECONDS.map(
      (delaySeconds, index) => [index + 1, delaySeconds] as const,
    ),
  )(
    'backs a pending payment off after attempt %i by %i seconds',
    (attempts, delaySeconds) => {
      expect(
        secondsUntil(nextReconcileAfterOf(scheduleWith({ attempts }))),
      ).toBe(delaySeconds);
    },
  );

  it('caps the backoff at one day', () => {
    expect(
      secondsUntil(nextReconcileAfterOf(scheduleWith({ attempts: 50 }))),
    ).toBe(86400);
  });

  it('backs a created payment off like a pending one', () => {
    expect(
      secondsUntil(
        nextReconcileAfterOf(scheduleWith({ status: 'created', attempts: 3 })),
      ),
    ).toBe(PENDING_RECONCILE_DELAYS_SECONDS[2]);
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
    const input = scheduleWith({
      attempts: 20,
      createdAt: new Date(NOW.getTime() - 29.9 * DAY_MS),
    });

    expect(nextReconcileAfterOf(input)).toBeNull();
  });

  it('keeps checking when the next check is still inside the window', () => {
    const input = scheduleWith({
      attempts: 1,
      createdAt: new Date(NOW.getTime() - 29.9 * DAY_MS),
    });

    expect(secondsUntil(nextReconcileAfterOf(input))).toBe(300);
  });
});

describe('reconcile lease', () => {
  it('outlasts two Paddle requests with room to spare', () => {
    expect(PADDLE_REQUEST_TIMEOUT_MS * 2).toBeLessThan(
      (RECONCILE_LEASE_SECONDS * 1000) / 2,
    );
  });
});
