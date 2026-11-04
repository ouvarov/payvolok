import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { HealthService } from './health.service';

const READINESS_TIMEOUT_MS = 2000;

const healthServiceWith = (ping: () => Promise<void>): HealthService =>
  new HealthService({ ping });

describe('HealthService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reports liveness without touching the database', () => {
    const ping = jest.fn();

    expect(healthServiceWith(ping).getLiveness()).toEqual({ status: 'ok' });
    expect(ping).not.toHaveBeenCalled();
  });

  it('is ready when the database answers', async () => {
    const healthService = healthServiceWith(() => Promise.resolve());

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

  it('logs the message of the wrapped cause when the driver error is wrapped', async () => {
    const wrapper = new Error('Failed query: select 1', {
      cause: new Error('connect ECONNREFUSED 10.0.0.5:5432'),
    });
    const healthService = healthServiceWith(() => Promise.reject(wrapper));

    await healthService.getReadiness().catch(() => undefined);

    expect(warn).toHaveBeenCalledWith(
      'Readiness check failed: connect ECONNREFUSED 10.0.0.5:5432',
    );
  });

  it('logs the cause code when the cause has an empty message', async () => {
    const emptyCause = Object.assign(new AggregateError([]), {
      code: 'ECONNREFUSED',
    });
    const healthService = healthServiceWith(() =>
      Promise.reject(
        new Error('Failed query: select 1', { cause: emptyCause }),
      ),
    );

    await healthService.getReadiness().catch(() => undefined);

    expect(warn).toHaveBeenCalledWith('Readiness check failed: ECONNREFUSED');
  });

  it('logs the error name when the cause has no message and no code', async () => {
    const healthService = healthServiceWith(() =>
      Promise.reject(
        new Error('Failed query: select 1', { cause: new TypeError() }),
      ),
    );

    await healthService.getReadiness().catch(() => undefined);

    expect(warn).toHaveBeenCalledWith('Readiness check failed: TypeError');
  });

  it('throws 503 when the database does not answer in time', async () => {
    const healthService = healthServiceWith(() => new Promise<void>(() => {}));

    const outcome = healthService
      .getReadiness()
      .catch((caught: unknown) => caught);
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(outcome).resolves.toBeInstanceOf(ServiceUnavailableException);
  });
});
