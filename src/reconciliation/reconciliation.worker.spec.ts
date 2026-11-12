import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { Env } from '@/config/env.schema';
import type { IdempotencyService } from '@/idempotency/idempotency.service';

import {
  IDEMPOTENCY_PURGE_BATCH_SIZE,
  IDEMPOTENCY_PURGE_INTERVAL_MS,
  IDEMPOTENCY_PURGE_MAX_BATCHES,
  RECONCILE_BATCH_SIZE,
  RECONCILIATION_STOP_TIMEOUT_MS,
} from './reconciliation.constants';
import type {
  ClaimedPayment,
  ReconciliationRepository,
  ReconciliationScopeKey,
} from './reconciliation.repository';
import type {
  ReconcileResult,
  ReconciliationService,
} from './reconciliation.service';
import { ReconciliationWorker } from './reconciliation.worker';

const POLL_INTERVAL_MS = 1000;
const LONG_INTERVAL_MS = 60 * 60 * 1000;

const claimedPaymentWith = (
  overrides: Partial<ClaimedPayment> = {},
): ClaimedPayment => ({
  id: 'payment-1',
  provider: 'fake',
  providerPaymentId: 'provider-1',
  status: 'pending',
  purpose: 'one_off',
  createdAt: new Date(0),
  reconcileAttempts: 1,
  reconciledAt: new Date(0),
  ...overrides,
});

const CHECKED: ReconcileResult = {
  outcome: 'checked',
  scopeKey: 'fake',
  isChanged: false,
};

const paddleUnavailable: ReconcileResult = {
  outcome: 'provider_failed',
  scopeKey: 'paddle',
  failure: { kind: 'unavailable', detail: 'paddle is down' },
};

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

type WorkerOptions = { isEnabled?: boolean; pollIntervalMs?: number };

describe('ReconciliationWorker', () => {
  let claimNext: jest.Mock<
    Promise<ClaimedPayment | null>,
    [readonly ReconciliationScopeKey[]]
  >;
  let reconcile: jest.Mock<Promise<ReconcileResult>, [ClaimedPayment]>;
  let purgeExpired: jest.Mock<Promise<number>, [number]>;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  const workerWith = ({
    isEnabled = true,
    pollIntervalMs = POLL_INTERVAL_MS,
  }: WorkerOptions = {}): ReconciliationWorker => {
    const config: Pick<
      Env,
      'RECONCILIATION_WORKER_ENABLED' | 'RECONCILIATION_POLL_INTERVAL_MS'
    > = {
      RECONCILIATION_WORKER_ENABLED: isEnabled,
      RECONCILIATION_POLL_INTERVAL_MS: pollIntervalMs,
    };

    return new ReconciliationWorker(
      {
        get: (key: keyof typeof config) => config[key],
      } as unknown as ConfigService<Env, true>,
      { claimNext } as unknown as ReconciliationRepository,
      { reconcile } as unknown as ReconciliationService,
      { purgeExpired } as unknown as IdempotencyService,
    );
  };

  const startedWorker = async (
    options: WorkerOptions = {},
  ): Promise<ReconciliationWorker> => {
    const worker = workerWith(options);
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    return worker;
  };

  const claimRows = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      claimNext.mockResolvedValueOnce(
        claimedPaymentWith({ id: `payment-${index}` }),
      );
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    claimNext = jest
      .fn<Promise<ClaimedPayment | null>, [readonly ReconciliationScopeKey[]]>()
      .mockResolvedValue(null);
    reconcile = jest
      .fn<Promise<ReconcileResult>, [ClaimedPayment]>()
      .mockResolvedValue(CHECKED);
    purgeExpired = jest.fn<Promise<number>, [number]>().mockResolvedValue(0);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('makes no database call during boot', () => {
    workerWith().onApplicationBootstrap();

    expect(claimNext).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('runs the first cycle at bootstrap, not after the interval', async () => {
    claimRows(1);

    await startedWorker({ pollIntervalMs: LONG_INTERVAL_MS });

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('claims once per interval when nothing is due', async () => {
    await startedWorker();
    expect(claimNext).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(claimNext).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(claimNext).toHaveBeenCalledTimes(2);
  });

  it('checks at most one batch per cycle and leaves the rest for the next', async () => {
    claimRows(RECONCILE_BATCH_SIZE + 5);

    await startedWorker();
    expect(reconcile).toHaveBeenCalledTimes(RECONCILE_BATCH_SIZE);

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(RECONCILE_BATCH_SIZE + 5);
  });

  it('returns the number of checks from a drain', async () => {
    claimRows(3);

    await expect(workerWith({ isEnabled: false }).drain()).resolves.toBe(3);
  });

  it('skips a failing provider for the rest of the cycle only', async () => {
    claimRows(2);
    reconcile.mockResolvedValueOnce(paddleUnavailable);

    await startedWorker();

    expect(claimNext.mock.calls).toEqual([[[]], [['paddle']], [['paddle']]]);

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(claimNext).toHaveBeenLastCalledWith([]);
  });

  it('warns once while a provider keeps failing and logs its recovery once', async () => {
    reconcile.mockResolvedValue(paddleUnavailable);
    const worker = workerWith({ isEnabled: false });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      claimNext.mockResolvedValueOnce(
        claimedPaymentWith({ provider: 'paddle' }),
      );
      await worker.drain();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('paddle'));

    reconcile.mockResolvedValue({ ...CHECKED, scopeKey: 'paddle' });
    claimNext
      .mockResolvedValueOnce(claimedPaymentWith({ provider: 'paddle' }))
      .mockResolvedValueOnce(claimedPaymentWith({ provider: 'paddle' }));
    await worker.drain();

    expect(
      log.mock.calls.filter(([message]) =>
        String(message).includes('paddle again'),
      ),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports a misconfigured provider as an error', async () => {
    claimRows(1);
    reconcile.mockResolvedValueOnce({
      outcome: 'provider_failed',
      scopeKey: 'paddle',
      failure: { kind: 'misconfigured', detail: 'no key' },
    });

    await workerWith({ isEnabled: false }).drain();

    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a summary only when a check changed something', async () => {
    claimRows(2);
    reconcile.mockResolvedValueOnce({ ...CHECKED, isChanged: true });
    const worker = workerWith({ isEnabled: false });

    await worker.drain();
    expect(log).toHaveBeenCalledTimes(1);

    claimRows(1);
    await worker.drain();
    expect(log).toHaveBeenCalledTimes(1);
  });

  describe('purge', () => {
    it('runs at boot after the checks, then at most hourly', async () => {
      claimRows(1);
      const calls: string[] = [];
      reconcile.mockImplementation(() => {
        calls.push('reconcile');
        return Promise.resolve(CHECKED);
      });
      purgeExpired.mockImplementation(() => {
        calls.push('purge');
        return Promise.resolve(0);
      });

      await startedWorker();
      expect(calls).toEqual(['reconcile', 'purge']);

      await jest.advanceTimersByTimeAsync(
        IDEMPOTENCY_PURGE_INTERVAL_MS - POLL_INTERVAL_MS,
      );
      expect(purgeExpired).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(purgeExpired).toHaveBeenCalledTimes(2);
    });

    it('repeats full batches up to the cap', async () => {
      purgeExpired.mockResolvedValue(IDEMPOTENCY_PURGE_BATCH_SIZE);

      await expect(workerWith({ isEnabled: false }).purge()).resolves.toBe(
        IDEMPOTENCY_PURGE_BATCH_SIZE * IDEMPOTENCY_PURGE_MAX_BATCHES,
      );
      expect(purgeExpired).toHaveBeenCalledTimes(IDEMPOTENCY_PURGE_MAX_BATCHES);
    });

    it('stops after a short batch', async () => {
      purgeExpired
        .mockResolvedValueOnce(IDEMPOTENCY_PURGE_BATCH_SIZE)
        .mockResolvedValueOnce(3);

      await expect(workerWith({ isEnabled: false }).purge()).resolves.toBe(
        IDEMPOTENCY_PURGE_BATCH_SIZE + 3,
      );
      expect(purgeExpired).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('retries at the next cycle after a failed purge', async () => {
      purgeExpired.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      await startedWorker();
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(purgeExpired).toHaveBeenCalledTimes(2);
    });
  });

  describe('on shutdown', () => {
    it('waits for the check in flight and claims no other', async () => {
      const slowCheck = deferred<ReconcileResult>();
      claimRows(2);
      reconcile.mockReturnValueOnce(slowCheck.promise);
      const worker = await startedWorker();

      let isStopped = false;
      const stopping = worker.beforeApplicationShutdown().then(() => {
        isStopped = true;
      });
      await jest.advanceTimersByTimeAsync(RECONCILIATION_STOP_TIMEOUT_MS - 1);
      expect(isStopped).toBe(false);

      slowCheck.resolve(CHECKED);
      await stopping;

      expect(claimNext).toHaveBeenCalledTimes(1);
      expect(purgeExpired).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns at the deadline when the check hangs', async () => {
      claimRows(1);
      reconcile.mockReturnValueOnce(new Promise(() => undefined));
      const worker = await startedWorker();

      let isStopped = false;
      const stopping = worker.beforeApplicationShutdown().then(() => {
        isStopped = true;
      });
      await jest.advanceTimersByTimeAsync(RECONCILIATION_STOP_TIMEOUT_MS - 1);
      expect(isStopped).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('clears the timer', async () => {
      const worker = await startedWorker();

      await worker.beforeApplicationShutdown();

      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('when disabled', () => {
    it('starts no timer and runs no cycle', async () => {
      await startedWorker({ isEnabled: false });
      await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);

      expect(jest.getTimerCount()).toBe(0);
      expect(claimNext).not.toHaveBeenCalled();
      expect(purgeExpired).not.toHaveBeenCalled();
    });
  });

  describe('when the database is down', () => {
    it('warns once, keeps its interval and logs the recovery once', async () => {
      claimNext.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await startedWorker();
      await jest.advanceTimersByTimeAsync(4 * POLL_INTERVAL_MS);

      expect(claimNext).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledTimes(1);

      claimNext.mockResolvedValue(null);
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(
        log.mock.calls.filter(([message]) =>
          String(message).includes('recovered'),
        ),
      ).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
