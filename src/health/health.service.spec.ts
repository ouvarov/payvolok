import { ServiceUnavailableException } from '@nestjs/common';

import type { Database } from '@/database/drizzle';

import { HealthService } from './health.service';

const READINESS_TIMEOUT_MS = 2000;

const healthServiceWith = (execute: () => Promise<unknown>): HealthService =>
  new HealthService({ execute } as unknown as Database);

describe('HealthService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports liveness without touching the database', () => {
    const execute = jest.fn();

    expect(healthServiceWith(execute).getLiveness()).toEqual({ status: 'ok' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('is ready when the database answers', async () => {
    const healthService = healthServiceWith(() => Promise.resolve([]));

    await expect(healthService.getReadiness()).resolves.toEqual({
      status: 'ok',
    });
  });

  it('throws 503 without connection details when the database fails', async () => {
    const healthService = healthServiceWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    );

    const error: unknown = await healthService
      .getReadiness()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'unavailable',
    });
  });

  it('throws 503 when the database does not answer in time', async () => {
    const healthService = healthServiceWith(() => new Promise(() => {}));

    const outcome = healthService
      .getReadiness()
      .catch((caught: unknown) => caught);
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(outcome).resolves.toBeInstanceOf(ServiceUnavailableException);
  });
});
