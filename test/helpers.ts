import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';

import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { validateEnv, type Env } from '@/config/env.schema';
import type { Database } from '@/database/drizzle';
import { webhookEvents } from '@/database/schemas/webhook-events.schema';

const PGLITE_POOL_MAX = 1;
const REAL_POSTGRES_POOL_MAX = 5;
const LOCK_WAIT_POLL_MS = 100;
const LOCK_WAIT_DEADLINE_MS = 8000;
// setup-env.ts configures the SHA-256 of this key.
const TEST_API_KEY = 'e2e-test-api-key-with-enough-length-0001';

const databaseUrl = process.env.E2E_DATABASE_URL as string;
const isRealPostgres = process.env.E2E_REAL_POSTGRES === 'true';
const describeOnRealPostgres = isRealPostgres ? describe : describe.skip;
const databasePoolMax = isRealPostgres
  ? REAL_POSTGRES_POOL_MAX
  : PGLITE_POOL_MAX;

// The worker is off unless a test asks for it: an enabled worker in one spec
// file would claim rows another file on the same database still asserts on.
type E2eAppOptions = {
  appDatabaseUrl?: string;
  appDatabasePoolMax?: number;
  isWorkerEnabled?: boolean;
  pollIntervalMs?: number;
  fakeWebhookSecret?: string;
  extraControllers?: Type<unknown>[];
};

type DatabaseCause = {
  code?: string;
  message?: string;
  constraint_name?: string;
};

const createE2eApp = async ({
  appDatabaseUrl = databaseUrl,
  appDatabasePoolMax = databasePoolMax,
  isWorkerEnabled = false,
  pollIntervalMs,
  fakeWebhookSecret,
  extraControllers = [],
}: E2eAppOptions = {}): Promise<INestApplication> => {
  const env = validateEnv({
    ...process.env,
    DATABASE_URL: appDatabaseUrl,
    DATABASE_POOL_MAX: appDatabasePoolMax,
    WEBHOOK_WORKER_ENABLED: String(isWorkerEnabled),
    ...(pollIntervalMs === undefined
      ? {}
      : { WEBHOOK_POLL_INTERVAL_MS: pollIntervalMs }),
    ...(fakeWebhookSecret === undefined
      ? {}
      : { FAKE_WEBHOOK_SECRET: fakeWebhookSecret }),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  })
    .overrideProvider(ConfigService)
    .useValue({ get: (key: keyof Env) => env[key] })
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return app;
};

const serverOf = (app: INestApplication): Server =>
  app.getHttpServer() as Server;

const databaseCauseOf = async (
  query: () => PromiseLike<unknown>,
): Promise<DatabaseCause> => {
  const error = (await Promise.resolve(query()).then(
    () => ({}),
    (caught: unknown) => caught,
  )) as { cause?: DatabaseCause };

  return error.cause ?? {};
};

const insertInboxEvent = async (db: Database): Promise<string> => {
  const [{ id }] = await db
    .insert(webhookEvents)
    .values({
      provider: 'fake',
      dedupKey: randomUUID(),
      status: 'received',
      signatureValid: true,
      rawBody: Buffer.from('{}'),
      nextAttemptAt: sql`clock_timestamp()`,
    })
    .returning({ id: webhookEvents.id });

  return id;
};

const trackSettled = <T>(work: Promise<T>) => {
  const tracker = { isSettled: false, work };
  const markSettled = () => {
    tracker.isSettled = true;
  };
  work.then(markSettled, markSettled);

  return tracker;
};

const waitUntilBlockedBy = async (
  db: Database,
  blockerPid: number,
): Promise<boolean> => {
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;

  while (Date.now() < deadline) {
    const [{ waiting_count: waitingCount }] = await db.execute<{
      waiting_count: number;
    }>(sql`
      select count(*)::int as waiting_count
      from pg_stat_activity
      where wait_event_type = 'Lock'
        and ${blockerPid}::int = any(pg_blocking_pids(pid))
    `);
    if (waitingCount > 0) return true;

    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_MS));
  }

  return false;
};

export {
  createE2eApp,
  databaseCauseOf,
  databasePoolMax,
  databaseUrl,
  describeOnRealPostgres,
  insertInboxEvent,
  serverOf,
  TEST_API_KEY,
  trackSettled,
  waitUntilBlockedBy,
};
