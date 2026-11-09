import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { WebhooksRepository } from '@/webhooks/webhooks.repository';

import { createE2eApp, databaseUrl, serverOf } from './helpers';

const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/none';
const HEALTH_POOL_MAX = 1;
const FAST_POLL_INTERVAL_MS = 100;
const FAILING_CYCLES_TO_WATCH = 4;
const WAIT_POLL_MS = 50;
const WAIT_DEADLINE_MS = 30000;
const SLOW_TEST_TIMEOUT_MS = 60000;
const WORKER_WARN_PREFIX = 'Webhook worker';

const brokenWorkerApp = (): Promise<INestApplication> =>
  createE2eApp({
    appDatabaseUrl: UNREACHABLE_DATABASE_URL,
    appDatabasePoolMax: HEALTH_POOL_MAX,
    isWorkerEnabled: true,
    pollIntervalMs: FAST_POLL_INTERVAL_MS,
  });

const waitFor = async (condition: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }

  return condition();
};

describe('Health routes', () => {
  let healthyApp: INestApplication;
  let brokenApp: INestApplication;

  beforeAll(async () => {
    healthyApp = await createE2eApp({
      appDatabaseUrl: databaseUrl,
      appDatabasePoolMax: HEALTH_POOL_MAX,
    });
    brokenApp = await brokenWorkerApp();
  });

  afterAll(async () => {
    await healthyApp.close();
    await brokenApp.close();
  });

  it('GET /health/live returns 200 when the database is reachable', async () => {
    const response = await request(serverOf(healthyApp))
      .get('/health/live')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/live returns 200 when the database is down', async () => {
    const response = await request(serverOf(brokenApp))
      .get('/health/live')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 200 when the database answers', async () => {
    const response = await request(serverOf(healthyApp))
      .get('/health/ready')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 503 without connection details when the database is unreachable', async () => {
    const response = await request(serverOf(brokenApp))
      .get('/health/ready')
      .expect(503);

    expect(response.body).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response.body)).not.toMatch(/127\.0\.0\.1|nobody/);
  });
});

describe('Webhook worker on a down database', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it(
    'lets boot finish first, warns once over many failing cycles, keeps the routes and closes',
    async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const claimNext = jest.spyOn(WebhooksRepository.prototype, 'claimNext');

      const app = await brokenWorkerApp();
      const claimsAtBoot = claimNext.mock.calls.length;
      const hasRetried = await waitFor(
        () => claimNext.mock.calls.length >= FAILING_CYCLES_TO_WATCH,
      );

      await request(serverOf(app)).get('/health/live').expect(200);
      await request(serverOf(app)).get('/health/ready').expect(503);
      const workerWarns = warn.mock.calls.filter(([message]) =>
        String(message).startsWith(WORKER_WARN_PREFIX),
      );
      await expect(app.close()).resolves.toBeUndefined();

      expect(claimsAtBoot).toBe(0);
      expect(hasRetried).toBe(true);
      expect(workerWarns).toHaveLength(1);
      expect(JSON.stringify(workerWarns)).not.toMatch(/127\.0\.0\.1|nobody/);
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
