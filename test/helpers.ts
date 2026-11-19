import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { Abstract, INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { validateEnv, type Env } from '@/config/env.schema';
import type { Database } from '@/database/drizzle';
import { webhookEvents } from '@/database/schemas/webhook-events.schema';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_FAKE_CREDENTIALS_REF,
  SEED_PADDLE_ACCOUNT_ID,
  SEED_STRIPE_ACCOUNT_ID,
} from '@/provider-accounts/provider-accounts.constants';
import { ProviderCredentialsResolver } from '@/provider-accounts/provider-credentials.resolver';
import type { FakeWireBody } from '@/providers/fake/fake-wire-format';
import { FakeProvider } from '@/providers/fake/fake.provider';
import { PaddleProvider } from '@/providers/paddle/paddle.provider';
import { boundProviderOf } from '@/providers/bound-provider';
import type {
  BoundProvider,
  WebhookRequest,
} from '@/providers/payment-provider.port';
import type { RedactedSecret } from '@/providers/provider-credentials';
import type { ProviderCode } from '@/providers/provider.constants';

import { TEST_API_KEY } from './test-api-key';

const PGLITE_POOL_MAX = 1;
const REAL_POSTGRES_POOL_MAX = 5;
const LOCK_WAIT_POLL_MS = 100;
const LOCK_WAIT_DEADLINE_MS = 8000;

const FAKE_SIGNATURE_HEADER = 'x-fake-signature';
const SEED_FAKE_WEBHOOK_PATH = `/webhooks/fake/${SEED_FAKE_ACCOUNT_ID}`;
const SEED_PADDLE_WEBHOOK_PATH = `/webhooks/paddle/${SEED_PADDLE_ACCOUNT_ID}`;

const SEED_ACCOUNT_ID_BY_PROVIDER: Record<ProviderCode, string> = {
  fake: SEED_FAKE_ACCOUNT_ID,
  paddle: SEED_PADDLE_ACCOUNT_ID,
  stripe: SEED_STRIPE_ACCOUNT_ID,
};

const databaseUrl = process.env.E2E_DATABASE_URL as string;
const isRealPostgres = process.env.E2E_REAL_POSTGRES === 'true';
const describeOnRealPostgres = isRealPostgres ? describe : describe.skip;
const databasePoolMax = isRealPostgres
  ? REAL_POSTGRES_POOL_MAX
  : PGLITE_POOL_MAX;

// The workers are off unless a test asks for them: an enabled worker in one
// spec file would claim rows another file on the same database still asserts on.
type E2eAppOptions = {
  appDatabaseUrl?: string;
  appDatabasePoolMax?: number;
  isWorkerEnabled?: boolean;
  pollIntervalMs?: number;
  isReconciliationEnabled?: boolean;
  reconciliationPollIntervalMs?: number;
  fakeWebhookSecret?: string;
  extraControllers?: Type<unknown>[];
  paddleEnv?: PaddleEnv;
  paddleProvider?: PaddleProvider;
  classOverrides?: ClassOverride[];
};

type ClassOverride = {
  provide: Type<unknown> | Abstract<unknown>;
  useClass: Type<unknown>;
};

type PaddleEnv = Partial<
  Pick<Env, 'PADDLE_API_KEY' | 'PADDLE_WEBHOOK_SECRET' | 'PADDLE_CLIENT_TOKEN'>
>;

// A bound fake account that also signs deliveries with that account's secret.
type FakeSigner = BoundProvider & {
  secret: RedactedSecret;
  buildPaymentWebhooks: (
    providerPaymentId: string,
    startedAt: Date,
  ) => WebhookRequest[];
  buildRefundWebhooks: (
    providerRefundId: string,
    startedAt: Date,
  ) => WebhookRequest[];
  buildWebhook: (wireBody: FakeWireBody) => WebhookRequest;
  signRawBody: (rawBody: Buffer) => WebhookRequest;
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
  isReconciliationEnabled = false,
  reconciliationPollIntervalMs,
  fakeWebhookSecret,
  extraControllers = [],
  paddleEnv = {},
  paddleProvider,
  classOverrides = [],
}: E2eAppOptions = {}): Promise<INestApplication> => {
  const env = validateEnv({
    ...process.env,
    DATABASE_URL: appDatabaseUrl,
    DATABASE_POOL_MAX: appDatabasePoolMax,
    WEBHOOK_WORKER_ENABLED: String(isWorkerEnabled),
    ...(pollIntervalMs === undefined
      ? {}
      : { WEBHOOK_POLL_INTERVAL_MS: pollIntervalMs }),
    RECONCILIATION_WORKER_ENABLED: String(isReconciliationEnabled),
    ...(reconciliationPollIntervalMs === undefined
      ? {}
      : { RECONCILIATION_POLL_INTERVAL_MS: reconciliationPollIntervalMs }),
    ...(fakeWebhookSecret === undefined
      ? {}
      : { FAKE_WEBHOOK_SECRET: fakeWebhookSecret }),
    ...paddleEnv,
  });
  const moduleBuilder = Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  })
    .overrideProvider(ConfigService)
    .useValue({ get: (key: keyof Env) => env[key] });
  for (const { provide, useClass } of classOverrides) {
    moduleBuilder.overrideProvider(provide).useClass(useClass);
  }
  if (paddleProvider) {
    moduleBuilder.overrideProvider(PaddleProvider).useValue(paddleProvider);
  }
  const moduleRef = await moduleBuilder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return app;
};

// The columns a row written by the API gets, for tests that insert rows directly.
const seedColumnsOf = (
  provider: ProviderCode,
): { projectId: string; providerAccountId: string } => ({
  projectId: SEED_PROJECT_ID,
  providerAccountId: SEED_ACCOUNT_ID_BY_PROVIDER[provider],
});

const fakeSignerFor = (
  secret: RedactedSecret,
  adapter = new FakeProvider(),
  account = { id: SEED_FAKE_ACCOUNT_ID, projectId: SEED_PROJECT_ID },
): FakeSigner => {
  return {
    ...boundProviderOf(account, adapter, {
      provider: 'fake',
      webhookSecrets: [secret],
    }),
    secret,
    buildPaymentWebhooks: (providerPaymentId, startedAt) =>
      adapter.buildPaymentWebhooks(secret, providerPaymentId, startedAt),
    buildRefundWebhooks: (providerRefundId, startedAt) =>
      adapter.buildRefundWebhooks(secret, providerRefundId, startedAt),
    buildWebhook: (wireBody) => adapter.buildWebhook(secret, wireBody),
    signRawBody: (rawBody) => adapter.signRawBody(secret, rawBody),
  };
};

// Signs as the app's own fake account would, with the secret its resolver holds.
const fakeSignerOf = async (
  app: INestApplication,
  account: { id: string; projectId: string; credentialsRef: string } = {
    id: SEED_FAKE_ACCOUNT_ID,
    projectId: SEED_PROJECT_ID,
    credentialsRef: SEED_FAKE_CREDENTIALS_REF,
  },
): Promise<FakeSigner> => {
  const credentials = await app
    .get(ProviderCredentialsResolver)
    .resolve({ ...account, provider: 'fake' });
  const [secret] = credentials.webhookSecrets;

  return fakeSignerFor(secret, app.get(FakeProvider), account);
};

const serverOf = (app: INestApplication): Server =>
  app.getHttpServer() as Server;

// Otherwise superagent JSON-encodes a Buffer sent under a JSON or form type.
const sendBytesAsTheyAre = (rawBody: unknown): string => rawBody as string;

const deliverTo = (
  target: INestApplication,
  rawBody: Buffer,
  signature: string,
  providerCode = 'fake',
  providerAccountId = SEED_FAKE_ACCOUNT_ID,
) =>
  request(serverOf(target))
    .post(`/webhooks/${providerCode}/${providerAccountId}`)
    .set(FAKE_SIGNATURE_HEADER, signature)
    .serialize(sendBytesAsTheyAre)
    .send(rawBody);

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
      providerAccountId: SEED_FAKE_ACCOUNT_ID,
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
  deliverTo,
  describeOnRealPostgres,
  FAKE_SIGNATURE_HEADER,
  fakeSignerFor,
  fakeSignerOf,
  insertInboxEvent,
  SEED_FAKE_WEBHOOK_PATH,
  SEED_PADDLE_WEBHOOK_PATH,
  seedColumnsOf,
  serverOf,
  TEST_API_KEY,
  trackSettled,
  waitUntilBlockedBy,
};
export type { ClassOverride, FakeSigner };
