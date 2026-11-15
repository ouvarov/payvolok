import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { Env } from '@/config/env.schema';
import { SEED_FAKE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';

import type { WebhookEventProcessor } from './webhook-event.processor';
import { WebhookWorker, WORKER_STOP_TIMEOUT_MS } from './webhook.worker';
import type {
  ClaimedWebhookEvent,
  WebhookEventFinish,
  WebhooksRepository,
} from './webhooks.repository';

const POLL_INTERVAL_MS = 1000;
const LONG_INTERVAL_MS = 60 * 60 * 1000;

const PROCESSED: WebhookEventFinish = {
  status: 'processed',
  lastError: null,
  paymentIds: [],
};

const claimedRow = (id: string): ClaimedWebhookEvent => ({
  id,
  provider: 'fake',
  providerAccountId: SEED_FAKE_ACCOUNT_ID,
  replayOf: null,
  attempts: 1,
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

type WorkerOptions = { isEnabled?: boolean; pollIntervalMs?: number };

describe('WebhookWorker', () => {
  let claimNext: jest.Mock<Promise<ClaimedWebhookEvent | null>, []>;
  let findDelivery: jest.Mock;
  let finish: jest.Mock;
  let processEvent: jest.Mock<Promise<WebhookEventFinish>, []>;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  const workerWith = ({
    isEnabled = true,
    pollIntervalMs = POLL_INTERVAL_MS,
  }: WorkerOptions = {}): WebhookWorker => {
    const config: Pick<
      Env,
      'WEBHOOK_WORKER_ENABLED' | 'WEBHOOK_POLL_INTERVAL_MS'
    > = {
      WEBHOOK_WORKER_ENABLED: isEnabled,
      WEBHOOK_POLL_INTERVAL_MS: pollIntervalMs,
    };

    return new WebhookWorker(
      {
        get: (key: keyof typeof config) => config[key],
      } as unknown as ConfigService<Env, true>,
      { claimNext, findDelivery, finish } as unknown as WebhooksRepository,
      { process: processEvent } as unknown as WebhookEventProcessor,
    );
  };

  const startedWorker = async (
    options: WorkerOptions = {},
  ): Promise<WebhookWorker> => {
    const worker = workerWith(options);
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    return worker;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    claimNext = jest
      .fn<Promise<ClaimedWebhookEvent | null>, []>()
      .mockResolvedValue(null);
    findDelivery = jest.fn().mockResolvedValue(null);
    finish = jest.fn().mockResolvedValue(true);
    processEvent = jest
      .fn<Promise<WebhookEventFinish>, []>()
      .mockResolvedValue(PROCESSED);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
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

  it('claims once per interval on an empty queue', async () => {
    await startedWorker();
    expect(claimNext).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(claimNext).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(claimNext).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS);
    expect(claimNext).toHaveBeenCalledTimes(5);
  });

  it('processes rows until the claim returns nothing, then waits an interval', async () => {
    claimNext
      .mockResolvedValueOnce(claimedRow('row-1'))
      .mockResolvedValueOnce({ ...claimedRow('row-2'), replayOf: 'root-2' })
      .mockResolvedValue(null);

    await startedWorker();

    expect(claimNext).toHaveBeenCalledTimes(3);
    expect(findDelivery.mock.calls).toEqual([['row-1'], ['root-2']]);
    expect(finish.mock.calls).toEqual([
      [claimedRow('row-1'), PROCESSED],
      [{ ...claimedRow('row-2'), replayOf: 'root-2' }, PROCESSED],
    ]);

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(claimNext).toHaveBeenCalledTimes(3);
  });

  it('does not overlap a slow cycle', async () => {
    const slowClaim = deferred<ClaimedWebhookEvent | null>();
    claimNext.mockReturnValueOnce(slowClaim.promise);

    await startedWorker();
    await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
    expect(claimNext).toHaveBeenCalledTimes(1);

    slowClaim.resolve(null);
    await jest.advanceTimersByTimeAsync(0);
    expect(claimNext).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(claimNext).toHaveBeenCalledTimes(2);
  });

  it('runs exactly one more cycle for kicks during a cycle', async () => {
    const slowClaim = deferred<ClaimedWebhookEvent | null>();
    claimNext.mockReturnValueOnce(slowClaim.promise);
    const worker = await startedWorker({ pollIntervalMs: LONG_INTERVAL_MS });

    worker.kick();
    worker.kick();
    worker.kick();
    slowClaim.resolve(null);
    await jest.advanceTimersByTimeAsync(0);

    expect(claimNext).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(LONG_INTERVAL_MS - 1);
    expect(claimNext).toHaveBeenCalledTimes(2);
  });

  it('runs a kick at once and replaces the pending timer', async () => {
    const worker = await startedWorker({ pollIntervalMs: LONG_INTERVAL_MS });
    await jest.advanceTimersByTimeAsync(LONG_INTERVAL_MS / 2);

    worker.kick();
    await jest.advanceTimersByTimeAsync(0);
    expect(claimNext).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(LONG_INTERVAL_MS - 1);
    expect(claimNext).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(claimNext).toHaveBeenCalledTimes(3);
  });

  it('does nothing on a kick after stop', async () => {
    const worker = await startedWorker();
    await worker.beforeApplicationShutdown();

    worker.kick();
    await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);

    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timer on stop', async () => {
    const worker = await startedWorker();

    await worker.beforeApplicationShutdown();

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
    expect(claimNext).toHaveBeenCalledTimes(1);
  });

  it('waits on stop for the in-flight row and claims no other', async () => {
    const slowProcess = deferred<WebhookEventFinish>();
    claimNext.mockResolvedValueOnce(claimedRow('row-1'));
    claimNext.mockResolvedValueOnce(claimedRow('row-2'));
    processEvent.mockReturnValueOnce(slowProcess.promise);
    const worker = await startedWorker();

    let isStopped = false;
    const stopping = worker.beforeApplicationShutdown().then(() => {
      isStopped = true;
    });
    await jest.advanceTimersByTimeAsync(WORKER_STOP_TIMEOUT_MS - 1);
    expect(isStopped).toBe(false);

    slowProcess.resolve(PROCESSED);
    await stopping;

    expect(finish).toHaveBeenCalledWith(claimedRow('row-1'), PROCESSED);
    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns from stop at the deadline when the row hangs', async () => {
    claimNext.mockResolvedValueOnce(claimedRow('row-1'));
    processEvent.mockReturnValueOnce(new Promise(() => undefined));
    const worker = await startedWorker();

    let isStopped = false;
    const stopping = worker.beforeApplicationShutdown().then(() => {
      isStopped = true;
    });
    await jest.advanceTimersByTimeAsync(WORKER_STOP_TIMEOUT_MS - 1);
    expect(isStopped).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await stopping;
    expect(isStopped).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  describe('when disabled', () => {
    it('starts no timer and ignores a kick', async () => {
      const worker = await startedWorker({ isEnabled: false });

      worker.kick();
      await jest.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);

      expect(jest.getTimerCount()).toBe(0);
      expect(claimNext).not.toHaveBeenCalled();
    });

    it('still drains on request', async () => {
      claimNext
        .mockResolvedValueOnce(claimedRow('row-1'))
        .mockResolvedValueOnce(claimedRow('row-2'))
        .mockResolvedValue(null);
      const worker = workerWith({ isEnabled: false });

      await expect(worker.drain()).resolves.toBe(2);
      expect(finish).toHaveBeenCalledTimes(2);
    });
  });

  describe('when the database is down', () => {
    it('warns once, keeps its interval and logs the recovery once', async () => {
      claimNext.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await startedWorker();
      await jest.advanceTimersByTimeAsync(4 * POLL_INTERVAL_MS);

      expect(claimNext).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('ECONNREFUSED');

      claimNext.mockResolvedValue(null);
      await jest.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS);

      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
