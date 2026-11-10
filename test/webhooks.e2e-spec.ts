import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { PGlite } from '@electric-sql/pglite';
import { Logger, type INestApplication } from '@nestjs/common';
import {
  and,
  asc,
  DrizzleQueryError,
  eq,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import postgres from 'postgres';
import request from 'supertest';

import { WEBHOOK_BODY_LIMIT_BYTES } from '@/app.setup';
import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type NewPayment,
  type Payment,
  type PaymentEvent,
} from '@/database/schemas/payments.schema';
import { refunds } from '@/database/schemas/refunds.schema';
import {
  webhookEvents,
  type NewWebhookEvent,
  type WebhookEvent,
} from '@/database/schemas/webhook-events.schema';
import { FakeProvider } from '@/providers/fake/fake.provider';
import {
  ProviderError,
  type WebhookRequest,
} from '@/providers/payment-provider.port';
import { dedupKeyFromBody } from '@/providers/provider-events';
import { ProviderRegistry } from '@/providers/provider.registry';
import { ProvidersModule } from '@/providers/providers.module';
import {
  MAX_ATTEMPTS,
  WebhookEventProcessor,
} from '@/webhooks/webhook-event.processor';
import { WebhookWorker } from '@/webhooks/webhook.worker';
import { WebhooksRepository } from '@/webhooks/webhooks.repository';
import { WebhooksService } from '@/webhooks/webhooks.service';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import {
  createE2eApp,
  databaseCauseOf,
  databasePoolMax,
  databaseUrl,
  describeOnRealPostgres,
  insertInboxEvent,
  serverOf,
} from './helpers';

const SIGNATURE_HEADER = 'x-fake-signature';
const WRONG_SIGNATURE = '0'.repeat(64);
const INVALID_ROWS_CAP = 20;
const MIGRATIONS_BEFORE_INBOX = 5;
const PARALLEL_DELIVERIES = 20;
const POOL_WARMUP_SLEEP_SECONDS = 0.1;
const SLOW_TEST_TIMEOUT_MS = 60000;
const LEAK_MARKER = 'LEAKMARKER';
const LONG_POLL_INTERVAL_MS = 60 * 60 * 1000;
const SHORT_POLL_INTERVAL_MS = 200;
const WORKER_WAIT_POLL_MS = 100;
const WORKER_WAIT_DEADLINE_MS = 15000;
const LOCK_WAIT_DEADLINE_MS = 3000;
const FIRST_RETRY_DELAY_SECONDS = 30;
const LEASE_SECONDS = 300;
const RETRY_DELAY_TOLERANCE_SECONDS = 5;
const DRAINED_ROWS = 50;
const CLIENT_END_TIMEOUT_SECONDS = 5;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const paymentWireEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'payment.succeeded',
  purpose: 'one_off',
  reference: null,
  providerPaymentId: randomUUID(),
  providerSubscriptionId: null,
  amountMinor: 1000,
  currency: 'USD',
  failureReason: null,
  ...overrides,
});

const refundWireEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'refund.succeeded',
  providerPaymentId: randomUUID(),
  reference: null,
  refundReference: null,
  providerRefundId: randomUUID(),
  amountMinor: 400,
  currency: 'USD',
  ...overrides,
});

const subscriptionWireEvent = () => ({
  type: 'subscription.canceled',
  reference: null,
  providerSubscriptionId: randomUUID(),
  providerStatus: 'canceled',
  currentPeriodEnd: null,
});

const failedPaymentEvent = (failureReason: string | null) => ({
  type: 'payment.failed',
  purpose: 'one_off',
  reference: null,
  providerPaymentId: randomUUID(),
  providerSubscriptionId: null,
  amountMinor: 1000,
  currency: 'USD',
  failureReason,
});

const wireBodyWith = (eventId: string, events: unknown[]) =>
  Buffer.from(JSON.stringify({ eventId, occurredAt: null, events }));

const wireBody = (eventId: string = randomUUID()): Buffer =>
  wireBodyWith(eventId, [failedPaymentEvent(null)]);

const nonJsonBody = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0x00, 0xfe, 0x0a]), randomBytes(16)]);

const invalidKeyOf = (rawBody: Buffer): string =>
  `invalid:${createHash('sha256').update(rawBody).digest('hex')}`;

// Otherwise superagent JSON-encodes a Buffer sent under a JSON or form type.
const sendBytesAsTheyAre = (rawBody: unknown): string => rawBody as string;

describe('Webhooks route', () => {
  let app: INestApplication;
  let db: Database;
  let fakeProvider: FakeProvider;

  const signatureOf = (rawBody: Buffer): string =>
    fakeProvider.signRawBody(rawBody).headers[SIGNATURE_HEADER] as string;

  const deliverTo = (
    target: INestApplication,
    rawBody: Buffer,
    signature: string,
    providerCode = 'fake',
  ) =>
    request(serverOf(target))
      .post(`/webhooks/${providerCode}`)
      .set(SIGNATURE_HEADER, signature)
      .serialize(sendBytesAsTheyAre)
      .send(rawBody);

  const deliver = (rawBody: Buffer, providerCode?: string) =>
    deliverTo(app, rawBody, signatureOf(rawBody), providerCode);

  const rowsWithKey = (...dedupKeys: string[]): Promise<WebhookEvent[]> =>
    db
      .select()
      .from(webhookEvents)
      .where(inArray(webhookEvents.dedupKey, dedupKeys));

  const rowsForBody = (
    rawBody: Buffer,
    eventId = '',
  ): Promise<WebhookEvent[]> =>
    rowsWithKey(eventId, dedupKeyFromBody(rawBody), invalidKeyOf(rawBody));

  const errorAndWarnLogs = () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    return (): string =>
      JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
  };

  const startApp = async (): Promise<void> => {
    app = await createE2eApp();
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
    fakeProvider = app.get(FakeProvider);
  };

  beforeAll(startApp, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('unknown provider', () => {
    it.each(['unknown', 'constructor', '__proto__', 'toString'])(
      'answers 404 for %s, stores nothing and does not echo the name',
      async (providerCode) => {
        const eventId = randomUUID();
        const rawBody = wireBody(eventId);

        const response = await deliver(rawBody, providerCode).expect(404);

        expect(response.body).toEqual({
          statusCode: 404,
          message: 'Not Found',
        });
        expect(response.text).not.toContain(providerCode);
        expect(await rowsForBody(rawBody, eventId)).toHaveLength(0);
      },
    );
  });

  describe('valid signature', () => {
    it('stores one received row with the exact bytes and the facts of the event', async () => {
      const eventId = randomUUID();
      const rawBody = Buffer.from(
        `{ "eventId" : "${eventId}",\n  "occurredAt": null,\n  "events": ${JSON.stringify(
          [failedPaymentEvent('card_declined'), failedPaymentEvent('later')],
        )} }\n`,
      );

      const response = await deliver(rawBody)
        .set('Authorization', 'Bearer secret-value')
        .set('Cookie', 'session=secret-value')
        .set('Proxy-Authorization', 'Basic secret-value')
        .set('X-Forwarded-For', '203.0.113.1')
        .set('X-Real-IP', '203.0.113.1')
        .set('CF-Connecting-IP', '203.0.113.1')
        .set('X-Api-Key', 'secret-value')
        .set('X-Auth-Token', 'secret-value')
        .set('X-Authorization', 'secret-value')
        .set('api_key', 'secret-value')
        .set('X-Session-Id', 'secret-value')
        .set('Forwarded', 'for=203.0.113.1')
        .set('True-Client-IP', '203.0.113.1')
        .set('X-Request-Id', 'request-1')
        .set('Content-Type', 'application/json')
        .set('User-Agent', 'e2e-agent')
        .expect(200);

      expect(response.body).toEqual({ received: true });
      const [row, ...otherRows] = await rowsWithKey(eventId);
      expect(otherRows).toHaveLength(0);
      expect(row).toMatchObject({
        provider: 'fake',
        status: 'received',
        signatureValid: true,
        attempts: 0,
        eventTypes: ['payment.failed', 'payment.failed'],
        failureReason: 'card_declined',
        paymentIds: [],
        lastError: null,
        replayOf: null,
        finishedAt: null,
      });
      expect(row.rawBody?.equals(rawBody)).toBe(true);
      expect(row.headers).toEqual({
        [SIGNATURE_HEADER]: signatureOf(rawBody),
        'content-type': 'application/json',
        'content-length': String(rawBody.length),
        'user-agent': 'e2e-agent',
      });
    });

    it('makes the row due at once', async () => {
      const eventId = randomUUID();

      await deliver(wireBody(eventId)).expect(200);

      const [{ isDue }] = await db
        .select({
          isDue: sql<boolean>`${webhookEvents.nextAttemptAt} <= clock_timestamp()`,
        })
        .from(webhookEvents)
        .where(eq(webhookEvents.dedupKey, eventId));
      expect(isDue).toBe(true);
    });

    it('takes the first failure reason, without control characters and capped', async () => {
      const eventId = randomUUID();
      const longReason = `bad\u0000${'r'.repeat(300)}`;

      await deliver(
        wireBodyWith(eventId, [
          failedPaymentEvent(null),
          failedPaymentEvent(longReason),
        ]),
      ).expect(200);

      const [row] = await rowsWithKey(eventId);
      expect(row.failureReason).toBe(`bad${'r'.repeat(197)}`);
    });

    it('verifies an empty body as zero bytes', async () => {
      const rawBody = Buffer.alloc(0);

      await request(serverOf(app))
        .post('/webhooks/fake')
        .set(SIGNATURE_HEADER, signatureOf(rawBody))
        .expect(200);

      const [row] = await rowsWithKey(dedupKeyFromBody(rawBody));
      expect(row.rawBody?.length).toBe(0);
    });
  });

  describe('exact bytes', () => {
    it.each([
      ['a non-JSON type', 'text/plain'],
      ['a malformed type', ';;not a media type;;'],
      ['application/json', 'application/json'],
      ['a form type', 'application/x-www-form-urlencoded'],
    ])(
      'verifies a signed non-JSON body under %s',
      async (_case, contentType) => {
        const rawBody = nonJsonBody();

        await deliver(rawBody).set('Content-Type', contentType).expect(200);

        const [row] = await rowsWithKey(dedupKeyFromBody(rawBody));
        expect(row.rawBody?.equals(rawBody)).toBe(true);
        expect(row.eventTypes).toEqual(['unknown']);
        expect(row.headers['content-type']).toBe(contentType);
      },
    );

    it('verifies a signed body under no content type', async () => {
      const rawBody = nonJsonBody();

      await deliver(rawBody).expect(200);

      const [row] = await rowsWithKey(dedupKeyFromBody(rawBody));
      expect(row.rawBody?.equals(rawBody)).toBe(true);
      expect(row.headers).not.toHaveProperty(['content-type']);
    });

    it('verifies JSON whose bytes differ from its re-serialised form', async () => {
      const eventId = randomUUID();
      const compact = wireBody(eventId).toString();
      const rawBody = Buffer.from(` ${compact.replace(':', ' : ')}\n`);

      await deliver(rawBody)
        .set('Content-Type', 'application/json')
        .expect(200);

      const [row] = await rowsWithKey(eventId);
      expect(row.rawBody?.equals(rawBody)).toBe(true);
    });
  });

  describe('body limits', () => {
    it('accepts a body of exactly the limit', async () => {
      const rawBody = randomBytes(WEBHOOK_BODY_LIMIT_BYTES);

      await deliver(rawBody).expect(200);

      const [row] = await rowsWithKey(dedupKeyFromBody(rawBody));
      expect(row.rawBody?.equals(rawBody)).toBe(true);
    });

    it('answers 413 above the limit and stores nothing', async () => {
      const rawBody = randomBytes(WEBHOOK_BODY_LIMIT_BYTES + 1);

      await deliver(rawBody).expect(413);

      expect(await rowsForBody(rawBody)).toHaveLength(0);
    });

    it('answers 415 for a gzip body and stores nothing', async () => {
      const rawBody = gzipSync(wireBody());

      await deliver(rawBody).set('Content-Encoding', 'gzip').expect(415);

      expect(await rowsForBody(rawBody)).toHaveLength(0);
    });
  });

  describe('invalid signature', () => {
    // Each app holds its own hourly row budget, so these tests must not share one.
    beforeEach(async () => {
      await app.close();
      await startApp();
    }, SLOW_TEST_TIMEOUT_MS);

    it('answers a generic 401 and stores a metadata-only ignored row', async () => {
      const rawBody = nonJsonBody();

      const response = await deliverTo(app, rawBody, WRONG_SIGNATURE)
        .set('X-Request-Id', 'request-1')
        .expect(401);

      expect(response.body).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
      });
      const rows = await rowsForBody(rawBody);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        dedupKey: invalidKeyOf(rawBody),
        status: 'ignored',
        signatureValid: false,
        rawBody: null,
        eventTypes: [],
        failureReason: null,
        nextAttemptAt: null,
      });
      expect(rows[0].headers).toEqual({});
      expect(rows[0].finishedAt).toBeInstanceOf(Date);
    });

    it('rejects a missing signature', async () => {
      const rawBody = nonJsonBody();

      await request(serverOf(app))
        .post('/webhooks/fake')
        .send(rawBody)
        .expect(401);

      const rows = await rowsForBody(rawBody);
      expect(rows.map(({ status }) => status)).toEqual(['ignored']);
    });

    it('rejects a signature for other bytes', async () => {
      const rawBody = wireBody();

      await deliverTo(app, rawBody, signatureOf(wireBody())).expect(401);

      expect((await rowsForBody(rawBody)).map(({ status }) => status)).toEqual([
        'ignored',
      ]);
    });

    it('rejects an empty body with a signature that is not for zero bytes', async () => {
      await request(serverOf(app))
        .post('/webhooks/fake')
        .set(SIGNATURE_HEADER, WRONG_SIGNATURE)
        .expect(401);
    });

    it('keeps one row for repeated invalid deliveries of one body', async () => {
      const rawBody = nonJsonBody();

      await deliverTo(app, rawBody, WRONG_SIGNATURE).expect(401);
      await deliverTo(app, rawBody, WRONG_SIGNATURE).expect(401);

      expect(await rowsForBody(rawBody)).toHaveLength(1);
    });

    it('does not let an invalid row block a later valid delivery of the same bytes', async () => {
      const rawBody = nonJsonBody();

      await deliverTo(app, rawBody, WRONG_SIGNATURE).expect(401);
      await deliver(rawBody).expect(200);

      const rows = await rowsForBody(rawBody);
      expect(rows.map(({ status }) => status).sort()).toEqual([
        'ignored',
        'received',
      ]);
    });

    it('still answers 401 when the row insert fails and leaks no parameter', async () => {
      const logs = errorAndWarnLogs();
      jest
        .spyOn(WebhooksRepository.prototype, 'insertInvalidIfAbsent')
        .mockRejectedValue(
          new DrizzleQueryError('insert', [LEAK_MARKER], new Error('down')),
        );

      const response = await deliverTo(
        app,
        nonJsonBody(),
        WRONG_SIGNATURE,
      ).expect(401);

      expect(response.text).not.toContain(LEAK_MARKER);
      expect(logs()).toContain('DrizzleQueryError');
      expect(logs()).not.toContain(LEAK_MARKER);
    });

    it(
      'stops storing rows past the cap in a fresh app and keeps answering 401',
      async () => {
        const freshApp = await createE2eApp();

        try {
          await freshApp.listen(0);
          const freshProvider = freshApp.get(FakeProvider);
          const bodies = Array.from(
            { length: INVALID_ROWS_CAP + 1 },
            nonJsonBody,
          );
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();

          for (const rawBody of bodies) {
            await deliverTo(freshApp, rawBody, WRONG_SIGNATURE).expect(401);
          }

          const lastBody = bodies[INVALID_ROWS_CAP];
          const storedKeys = (
            await rowsWithKey(...bodies.map(invalidKeyOf))
          ).map(({ dedupKey }) => dedupKey);
          expect(storedKeys).toHaveLength(INVALID_ROWS_CAP);
          expect(storedKeys).not.toContain(invalidKeyOf(lastBody));
          expect(warn).toHaveBeenCalledTimes(1);

          await request(serverOf(freshApp))
            .post('/webhooks/fake')
            .set(
              SIGNATURE_HEADER,
              freshProvider.signRawBody(lastBody).headers[
                SIGNATURE_HEADER
              ] as string,
            )
            .send(lastBody)
            .expect(200);
        } finally {
          await freshApp.close();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('failures', () => {
    it('answers 503 and stores nothing when verification is impossible', async () => {
      const logs = errorAndWarnLogs();
      jest.spyOn(fakeProvider, 'verifyWebhook').mockRejectedValue(
        new ProviderError(LEAK_MARKER, {
          providerCode: 'fake',
          kind: 'unavailable',
        }),
      );
      const rawBody = wireBody();

      const response = await deliverTo(app, rawBody, WRONG_SIGNATURE).expect(
        503,
      );

      expect(response.body).toEqual({
        statusCode: 503,
        message: 'Service Unavailable',
      });
      expect(await rowsForBody(rawBody)).toHaveLength(0);
      expect(logs()).toContain('ProviderError');
      expect(logs()).not.toContain(LEAK_MARKER);
    });

    it('answers a generic 503 for a real insert failure and leaks no parameter', async () => {
      const logs = errorAndWarnLogs();
      const eventId = randomUUID();
      const rawBody = wireBody(eventId);
      jest.spyOn(fakeProvider, 'parseWebhook').mockReturnValue([
        {
          type: `unknown\u0000${LEAK_MARKER}`,
          rawType: null,
          dedupKey: eventId,
          occurredAt: null,
        } as never,
      ]);

      const response = await deliver(rawBody)
        .set('X-Leak', LEAK_MARKER)
        .expect(503);

      expect(response.body).toEqual({
        statusCode: 503,
        message: 'Service Unavailable',
      });
      expect(await rowsWithKey(eventId)).toHaveLength(0);
      expect(logs()).toMatch(/DrizzleQueryError [0-9A-Z]{5}/);
      expect(logs()).not.toContain(LEAK_MARKER);
    });
  });

  describe('dedup', () => {
    it('answers 200 to a duplicate and keeps the first row', async () => {
      const eventId = randomUUID();
      const rawBody = wireBody(eventId);

      await deliver(rawBody).expect(200);
      const firstRows = await rowsWithKey(eventId);
      const response = await deliver(rawBody).expect(200);

      expect(response.body).toEqual({ received: true });
      expect(firstRows).toHaveLength(1);
      expect(await rowsWithKey(eventId)).toEqual(firstRows);
    });

    it('dedups two different bodies with one event id', async () => {
      const eventId = randomUUID();

      await deliver(wireBody(eventId)).expect(200);
      await deliver(wireBody(eventId)).expect(200);

      expect(await rowsWithKey(eventId)).toHaveLength(1);
    });

    it.each([
      ['a NUL byte', () => `evt\u0000${randomUUID()}`],
      ['over 255 characters', () => `${randomUUID()}${'a'.repeat(255)}`],
    ])(
      'stores an event id with %s under a hashed key and dedups its redelivery',
      async (_case, eventIdOf) => {
        const eventId = eventIdOf();
        const rawBody = wireBody(eventId);
        const hashedKey = dedupKeyFromBody(Buffer.from(eventId));

        await deliver(rawBody).expect(200);
        await deliver(rawBody).expect(200);

        const rows = await rowsWithKey(hashedKey);
        expect(hashedKey).toMatch(/^sha256:/);
        expect(rows).toHaveLength(1);
        expect(rows[0].rawBody?.equals(rawBody)).toBe(true);
      },
    );
  });

  describe('a provider key shaped like an invalid-signature key', () => {
    it('is stored under a hash and not dropped by the invalid row', async () => {
      const rejectedBody = nonJsonBody();
      const invalidKey = invalidKeyOf(rejectedBody);
      await deliverTo(app, rejectedBody, WRONG_SIGNATURE).expect(401);
      const rawBody = wireBody(invalidKey);

      await deliver(rawBody).expect(200);

      const invalidRows = await rowsWithKey(invalidKey);
      const [storedRow] = await rowsWithKey(
        dedupKeyFromBody(Buffer.from(invalidKey)),
      );
      expect(invalidRows.map(({ status }) => status)).toEqual(['ignored']);
      expect(storedRow.status).toBe('received');
      expect(storedRow.rawBody?.equals(rawBody)).toBe(true);
    });
  });

  describe('a parse failure', () => {
    it('stores a received row under the body hash and answers 200', async () => {
      const logs = errorAndWarnLogs();
      jest.spyOn(fakeProvider, 'parseWebhook').mockImplementation(() => {
        throw new Error(LEAK_MARKER);
      });
      const rawBody = wireBody();

      const response = await deliver(rawBody).expect(200);

      expect(response.body).toEqual({ received: true });
      const rows = await rowsForBody(rawBody);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        dedupKey: dedupKeyFromBody(rawBody),
        status: 'received',
        signatureValid: true,
        eventTypes: [],
        failureReason: null,
      });
      expect(rows[0].rawBody?.equals(rawBody)).toBe(true);
      expect(logs()).not.toContain(LEAK_MARKER);
    });
  });

  describe('the public surface', () => {
    it('needs no credential beyond the signature and returns no signature', async () => {
      const rawBody = wireBody();
      const signature = signatureOf(rawBody);

      const accepted = await deliver(rawBody).expect(200);
      const rejected = await deliverTo(
        app,
        nonJsonBody(),
        `${signature.slice(1)}0`,
      ).expect(401);

      for (const response of [accepted, rejected]) {
        expect(response.text).not.toContain(signature);
        expect(JSON.stringify(response.headers)).not.toContain(signature);
      }
    });

    it('maps exactly the public routes', () => {
      const httpInstance = app.getHttpAdapter().getInstance() as {
        router: { stack: { route?: { path: string } }[] };
      };

      expect(
        httpInstance.router.stack
          .flatMap(({ route }) => (route ? [route.path] : []))
          .sort(),
      ).toEqual([
        '/api/v1/payments',
        '/api/v1/payments/:id',
        '/health/live',
        '/health/ready',
        '/webhooks/:provider',
      ]);
    });

    it('exports only the registry from ProvidersModule', () => {
      expect(Reflect.getMetadata('exports', ProvidersModule)).toEqual([
        ProviderRegistry,
      ]);
    });
  });

  describe('inbox foreign keys', () => {
    const insertPayment = async (): Promise<string> => {
      const [{ id }] = await db
        .insert(payments)
        .values({
          provider: 'fake',
          providerPaymentId: randomUUID(),
          purpose: 'one_off',
          origin: 'api',
          status: 'pending',
          amountMinor: 1000,
          currency: 'USD',
        })
        .returning({ id: payments.id });

      return id;
    };

    const eventOf = (paymentId: string, webhookEventId: string) => ({
      paymentId,
      toStatus: 'succeeded' as const,
      outcome: 'applied' as const,
      reason: 'e2e',
      webhookEventId,
    });

    it('rejects a payment event with an unknown webhook_event_id', async () => {
      const paymentId = await insertPayment();

      const cause = await databaseCauseOf(() =>
        db.insert(paymentEvents).values(eventOf(paymentId, randomUUID())),
      );

      expect(cause.code).toBe('23503');
    });

    it('rejects deleting an inbox row a payment event references', async () => {
      const paymentId = await insertPayment();
      const webhookEventId = await insertInboxEvent(db);
      await db.insert(paymentEvents).values(eventOf(paymentId, webhookEventId));

      const cause = await databaseCauseOf(() =>
        db.delete(webhookEvents).where(eq(webhookEvents.id, webhookEventId)),
      );

      expect(cause.code).toBe('23503');
    });

    it('rejects a replay of an unknown inbox row', async () => {
      const cause = await databaseCauseOf(() =>
        db.insert(webhookEvents).values({
          provider: 'fake',
          dedupKey: randomUUID(),
          status: 'ignored',
          signatureValid: true,
          replayOf: randomUUID(),
          finishedAt: sql`clock_timestamp()`,
        }),
      );

      expect(cause.code).toBe('23503');
    });

    it(
      'delete orphan payment events in the migration and keep the others',
      async () => {
        const database = new PGlite();
        const olderMigrations = mkdtempSync(join(tmpdir(), 'payvolok-'));

        try {
          cpSync(MIGRATIONS_FOLDER, olderMigrations, { recursive: true });
          const journalPath = join(olderMigrations, 'meta', '_journal.json');
          const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
            entries: unknown[];
          };
          writeFileSync(
            journalPath,
            JSON.stringify({
              ...journal,
              entries: journal.entries.slice(0, MIGRATIONS_BEFORE_INBOX),
            }),
          );
          const emptyDrizzle = drizzlePglite(database);
          await migratePglite(emptyDrizzle, {
            migrationsFolder: olderMigrations,
          });
          const paymentRows = await database.query<{ id: string }>(`
            insert into payments
              (provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
            values ('fake', 'orphan-test', 'one_off', 'api', 'pending', 1000, 'USD')
            returning id
          `);
          const paymentId = paymentRows.rows[0].id;
          await database.query(
            `
              insert into payment_events
                (payment_id, to_status, outcome, reason, webhook_event_id)
              values
                ($1, 'pending', 'applied', 'orphan', $2),
                ($1, 'succeeded', 'applied', 'kept', null)
            `,
            [paymentId, randomUUID()],
          );

          await migratePglite(emptyDrizzle, {
            migrationsFolder: MIGRATIONS_FOLDER,
          });

          const eventRows = await database.query<{ reason: string }>(
            'select reason from payment_events',
          );
          expect(eventRows.rows).toEqual([{ reason: 'kept' }]);
        } finally {
          rmSync(olderMigrations, { recursive: true, force: true });
          await database.close();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('inbox constraints', () => {
    const ONE_BODY = Buffer.from('{}');
    const receivedRow = (): NewWebhookEvent => ({
      provider: 'fake',
      dedupKey: randomUUID(),
      status: 'received',
      signatureValid: true,
      rawBody: ONE_BODY,
      nextAttemptAt: new Date(),
    });
    const terminalRow = (): NewWebhookEvent => ({
      ...receivedRow(),
      status: 'processed',
      nextAttemptAt: null,
      finishedAt: new Date(),
    });
    const invalidRow = (): NewWebhookEvent => ({
      ...terminalRow(),
      status: 'ignored',
      signatureValid: false,
      rawBody: null,
    });

    let originalId: string;

    beforeAll(async () => {
      originalId = await insertInboxEvent(db);
    });

    it.each([
      [
        'a received row with no next_attempt_at',
        'webhook_events_next_attempt_at_check',
        () => ({ ...receivedRow(), nextAttemptAt: null }),
      ],
      [
        'a terminal row with a next_attempt_at',
        'webhook_events_next_attempt_at_check',
        () => ({ ...terminalRow(), nextAttemptAt: new Date() }),
      ],
      [
        'a terminal row with no finished_at',
        'webhook_events_finished_at_check',
        () => ({ ...terminalRow(), finishedAt: null }),
      ],
      [
        'a received row with a finished_at',
        'webhook_events_finished_at_check',
        () => ({ ...receivedRow(), finishedAt: new Date() }),
      ],
      [
        'an invalid row with a body',
        'webhook_events_raw_body_check',
        () => ({ ...invalidRow(), rawBody: ONE_BODY }),
      ],
      [
        'a valid row with no body',
        'webhook_events_raw_body_check',
        () => ({ ...terminalRow(), rawBody: null }),
      ],
      [
        'a replay with a body',
        'webhook_events_raw_body_check',
        () => ({ ...terminalRow(), replayOf: originalId }),
      ],
      [
        'an invalid row that is not ignored',
        'webhook_events_invalid_signature_ignored_check',
        () => ({ ...invalidRow(), status: 'failed' as const }),
      ],
      [
        'negative attempts',
        'webhook_events_attempts_check',
        () => ({ ...receivedRow(), attempts: -1 }),
      ],
      [
        'an unknown status',
        'webhook_events_status_check',
        () => ({ ...terminalRow(), status: 'bogus' as never }),
      ],
    ])('rejects %s', async (_case, constraintName, rowOf) => {
      const cause = await databaseCauseOf(() =>
        db.insert(webhookEvents).values(rowOf()),
      );

      expect(cause.code).toBe('23514');
      expect(cause.constraint_name).toBe(constraintName);
    });

    it.each([
      ['a received row', receivedRow],
      ['a terminal row', terminalRow],
      ['an invalid row', invalidRow],
    ])('accepts %s', async (_case, rowOf) => {
      await expect(
        db.insert(webhookEvents).values(rowOf()),
      ).resolves.toBeDefined();
    });

    it('indexes replay_of only where it is set', async () => {
      const [{ indexdef }] = await db.execute<{ indexdef: string }>(sql`
        select indexdef
        from pg_indexes
        where tablename = 'webhook_events'
          and indexname = 'webhook_events_replay_of_idx'
      `);

      expect(indexdef).toMatch(/\(replay_of\) WHERE \(replay_of IS NOT NULL\)/);
    });

    it('lets a replay without a body share the key of the original', async () => {
      const original = receivedRow();
      const [{ id }] = await db
        .insert(webhookEvents)
        .values(original)
        .returning({ id: webhookEvents.id });

      await db.insert(webhookEvents).values({
        ...terminalRow(),
        dedupKey: original.dedupKey,
        rawBody: null,
        replayOf: id,
      });

      expect(await rowsWithKey(original.dedupKey)).toHaveLength(2);
    });

    it('rejects a second original with one provider and key', async () => {
      const original = receivedRow();
      await db.insert(webhookEvents).values(original);

      const cause = await databaseCauseOf(() =>
        db.insert(webhookEvents).values(original),
      );

      expect(cause.code).toBe('23505');
    });
  });

  describe('payments defaults', () => {
    it('read clock_timestamp()', async () => {
      const columns = await db.execute<{
        column_name: string;
        column_default: string;
      }>(sql`
        select column_name, column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'payments'
          and column_name in ('created_at', 'updated_at')
        order by column_name
      `);

      expect(
        columns.map(({ column_name, column_default }) => [
          column_name,
          column_default,
        ]),
      ).toEqual([
        ['created_at', 'clock_timestamp()'],
        ['updated_at', 'clock_timestamp()'],
      ]);
    });
  });

  describe('worker', () => {
    const PAYMENT_INPUT = {
      currency: 'USD',
      description: 'e2e',
      returnUrl: 'https://example.test/return',
      webhookUrl: 'https://example.test/webhook',
    };

    const drain = (target: INestApplication = app): Promise<number> =>
      target.get(WebhookWorker).drain();

    const post = (webhook: WebhookRequest, target: INestApplication = app) =>
      deliverTo(
        target,
        webhook.rawBody,
        webhook.headers[SIGNATURE_HEADER] as string,
      ).expect(200);

    const postAndDrain = async (webhooks: WebhookRequest[]): Promise<void> => {
      for (const webhook of webhooks) {
        await post(webhook);
        await drain();
      }
    };

    const signed = (events: unknown[]): WebhookRequest =>
      fakeProvider.buildWebhook({
        eventId: randomUUID(),
        occurredAt: null,
        events,
      });

    const inboxRowById = async (
      id: string,
      database: Database = db,
    ): Promise<WebhookEvent> => {
      const [row] = await database
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, id));

      return row;
    };

    const originalRowsFor = (
      webhook: WebhookRequest,
      database: Database = db,
    ): Promise<WebhookEvent[]> =>
      database
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(
              webhookEvents.dedupKey,
              fakeProvider.parseWebhook(webhook)[0].dedupKey,
            ),
            isNull(webhookEvents.replayOf),
          ),
        );

    const inboxRowFor = async (
      webhook: WebhookRequest,
      database: Database = db,
    ): Promise<WebhookEvent> => {
      const [row] = await originalRowsFor(webhook, database);

      return row;
    };

    const waitForStatus = async (
      database: Database,
      id: string,
      status: WebhookEvent['status'],
    ): Promise<WebhookEvent> => {
      const deadline = Date.now() + WORKER_WAIT_DEADLINE_MS;
      let row = await inboxRowById(id, database);
      while (row.status !== status && Date.now() < deadline) {
        await sleep(WORKER_WAIT_POLL_MS);
        row = await inboxRowById(id, database);
      }

      return row;
    };

    const forceDue = (id: string) =>
      db
        .update(webhookEvents)
        .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
        .where(
          and(eq(webhookEvents.id, id), eq(webhookEvents.status, 'received')),
        );

    const insertDueRows = async (count: number): Promise<string[]> => {
      const rows = await db
        .insert(webhookEvents)
        .values(
          Array.from({ length: count }, (_value, index) => ({
            provider: 'fake' as const,
            dedupKey: randomUUID(),
            status: 'received' as const,
            signatureValid: true,
            rawBody: Buffer.from('{}'),
            nextAttemptAt: sql`clock_timestamp() - ${count - index}::integer * interval '1 second'`,
          })),
        )
        .returning({ id: webhookEvents.id });

      return rows.map(({ id }) => id);
    };

    const insertPayment = async (
      overrides: Partial<NewPayment> = {},
    ): Promise<Payment> => {
      const [payment] = await db
        .insert(payments)
        .values({
          provider: 'fake',
          providerPaymentId: null,
          purpose: 'one_off',
          origin: 'api',
          status: 'created',
          amountMinor: 1000,
          currency: 'USD',
          ...overrides,
        })
        .returning();

      return payment;
    };

    const rowFirstPayment = async (amountMinor = 1000) => {
      const payment = await insertPayment({ amountMinor });
      const { providerPaymentId } = await fakeProvider.createPayment({
        ...PAYMENT_INPUT,
        reference: payment.id,
        amountMinor,
      });

      return { payment, providerPaymentId };
    };

    const succeededRowFirstPayment = async () => {
      const rowFirst = await rowFirstPayment(1000);
      await postAndDrain(
        fakeProvider.buildPaymentWebhooks(
          rowFirst.providerPaymentId,
          new Date(),
        ),
      );

      return rowFirst;
    };

    const paymentOf = async (paymentId: string): Promise<Payment> => {
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId));

      return payment;
    };

    const paymentsWithProviderRef = (providerPaymentId: string) =>
      db
        .select()
        .from(payments)
        .where(eq(payments.providerPaymentId, providerPaymentId));

    const paymentEventsOf = (paymentId: string): Promise<PaymentEvent[]> =>
      db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, paymentId))
        .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));

    const refundsOf = (paymentId: string) =>
      db.select().from(refunds).where(eq(refunds.paymentId, paymentId));

    const warnsAbout = (warn: jest.SpyInstance, id: string): unknown[][] =>
      (warn.mock.calls as unknown[][]).filter(([message]) =>
        String(message).includes(id),
      );

    // Every other test leaves its rows received; a drain must not touch them by accident.
    beforeEach(async () => {
      await db
        .update(webhookEvents)
        .set({
          status: 'failed',
          lastError: 'Closed by the e2e worker tests',
          nextAttemptAt: null,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(eq(webhookEvents.status, 'received'));
    });

    describe('birth gate', () => {
      it.each(['one_off', 'subscription_initial'])(
        'keeps a %s event with a subscription id and no row received at attempt 1 without a payment',
        async (purpose) => {
          const event = paymentWireEvent({
            purpose,
            providerSubscriptionId: randomUUID(),
          });
          const webhook = signed([event]);

          await postAndDrain([webhook]);

          expect(await inboxRowFor(webhook)).toMatchObject({
            status: 'received',
            attempts: 1,
            paymentIds: [],
          });
          expect(
            await paymentsWithProviderRef(event.providerPaymentId),
          ).toHaveLength(0);
        },
      );

      it('births one provider row from a signed renewal and dedups its redelivery', async () => {
        const event = paymentWireEvent({
          purpose: 'subscription_renewal',
          providerSubscriptionId: randomUUID(),
        });
        const webhook = signed([event]);

        await postAndDrain([webhook, webhook]);

        const inboxRows = await originalRowsFor(webhook);
        const birthedPayments = await paymentsWithProviderRef(
          event.providerPaymentId,
        );
        expect(inboxRows).toHaveLength(1);
        expect(birthedPayments).toHaveLength(1);
        const [payment] = birthedPayments;
        expect(payment).toMatchObject({
          origin: 'provider',
          purpose: 'subscription_renewal',
          status: 'succeeded',
        });
        expect(inboxRows[0]).toMatchObject({
          status: 'processed',
          attempts: 1,
          paymentIds: [payment.id],
        });
        expect(await paymentEventsOf(payment.id)).toMatchObject([
          {
            fromStatus: null,
            toStatus: 'succeeded',
            webhookEventId: inboxRows[0].id,
          },
        ]);
      });
    });

    describe('row-first fake flows', () => {
      it.each([
        [1000, 'succeeded'],
        [1001, 'failed'],
        [1002, 'succeeded'],
        [1003, 'failed'],
        [1004, 'expired'],
        [1005, 'pending'],
      ])(
        'brings amount %i to %s and links every event to its inbox row',
        async (amountMinor, finalStatus) => {
          const { payment, providerPaymentId } =
            await rowFirstPayment(amountMinor);
          const webhooks = fakeProvider.buildPaymentWebhooks(
            providerPaymentId,
            new Date(),
          );

          await postAndDrain(webhooks);

          expect((await paymentOf(payment.id)).status).toBe(finalStatus);
          const inboxRows = await Promise.all(
            webhooks.map((webhook) => inboxRowFor(webhook)),
          );
          for (const row of inboxRows) {
            expect(row).toMatchObject({
              status: 'processed',
              attempts: 1,
              paymentIds: [payment.id],
              lastError: null,
            });
          }
          const events = await paymentEventsOf(payment.id);
          expect(events.length).toBeGreaterThan(0);
          const inboxIds = inboxRows.map(({ id }) => id);
          for (const event of events) {
            expect(inboxIds).toContain(event.webhookEventId);
          }
        },
      );

      it('writes no event for a repeated pending yet keeps the attempt on the inbox row', async () => {
        const { payment, providerPaymentId } = await rowFirstPayment(1002);
        const webhooks = fakeProvider.buildPaymentWebhooks(
          providerPaymentId,
          new Date(),
        );

        await postAndDrain(webhooks);

        const attemptRow = await inboxRowFor(webhooks[1]);
        const events = await paymentEventsOf(payment.id);
        expect(attemptRow).toMatchObject({
          status: 'processed',
          eventTypes: ['payment.attempt_failed'],
          paymentIds: [payment.id],
          failureReason: 'fake_declined',
        });
        expect(events.map(({ toStatus }) => toStatus)).toEqual([
          'pending',
          'succeeded',
        ]);
        expect(
          events.map(({ webhookEventId }) => webhookEventId),
        ).not.toContain(attemptRow.id);
      });

      it('writes the failure reason of payment.failed into the event', async () => {
        const { payment, providerPaymentId } = await rowFirstPayment(1001);

        await postAndDrain(
          fakeProvider.buildPaymentWebhooks(providerPaymentId, new Date()),
        );

        expect(await paymentEventsOf(payment.id)).toMatchObject([
          { toStatus: 'pending', reason: 'payment.pending' },
          { toStatus: 'failed', reason: 'fake_declined' },
        ]);
      });

      it('brings a partial fake refund to partially_refunded through the inbox', async () => {
        const { payment, providerPaymentId } = await succeededRowFirstPayment();
        const { providerRefundId } = await fakeProvider.refund({
          reference: randomUUID(),
          providerPaymentId,
          amountMinor: 400,
          currency: 'USD',
        });
        const refundWebhooks = fakeProvider.buildRefundWebhooks(
          providerRefundId as string,
          new Date(),
        );

        await postAndDrain(refundWebhooks);

        const succeededRow = await inboxRowFor(refundWebhooks[1]);
        const events = await paymentEventsOf(payment.id);
        expect((await paymentOf(payment.id)).status).toBe('partially_refunded');
        expect(await refundsOf(payment.id)).toMatchObject([
          { status: 'succeeded', amountMinor: 400, providerRefundId },
        ]);
        expect(succeededRow).toMatchObject({
          status: 'processed',
          paymentIds: [payment.id],
          lastError: null,
        });
        expect(events[events.length - 1]).toMatchObject({
          toStatus: 'partially_refunded',
          webhookEventId: succeededRow.id,
        });
      });

      it('applies a row-first event with a reference at the first attempt', async () => {
        const { payment, providerPaymentId } = await rowFirstPayment(1000);
        const [pendingWebhook] = fakeProvider.buildPaymentWebhooks(
          providerPaymentId,
          new Date(),
        );

        await postAndDrain([pendingWebhook]);

        expect(await inboxRowFor(pendingWebhook)).toMatchObject({
          status: 'processed',
          attempts: 1,
        });
        expect((await paymentOf(payment.id)).providerPaymentId).toBe(
          providerPaymentId,
        );
      });
    });

    describe('lease', () => {
      it('leases a claimed row for five minutes', async () => {
        const [id] = await insertDueRows(1);

        const claim = await app.get(WebhooksRepository).claimNext();
        const [{ leaseSeconds }] = await db
          .select({
            leaseSeconds: sql<number>`extract(epoch from ${webhookEvents.nextAttemptAt} - clock_timestamp())::float8`,
          })
          .from(webhookEvents)
          .where(eq(webhookEvents.id, id));

        expect(claim).toMatchObject({ id, attempts: 1 });
        expect(leaseSeconds).toBeGreaterThan(
          LEASE_SECONDS - RETRY_DELAY_TOLERANCE_SECONDS,
        );
        expect(leaseSeconds).toBeLessThanOrEqual(LEASE_SECONDS);
      });
    });

    describe('ignored deliveries', () => {
      it('ignores unknown and subscription-only deliveries without writing payments', async () => {
        const webhooks = [
          signed([{ type: 'some.new.type' }]),
          signed([subscriptionWireEvent(), subscriptionWireEvent()]),
          fakeProvider.signRawBody(nonJsonBody()),
        ];
        const inboxRowIds: string[] = [];

        await postAndDrain(webhooks);

        for (const webhook of webhooks) {
          const row = await inboxRowFor(webhook);
          inboxRowIds.push(row.id);
          expect(row).toMatchObject({
            status: 'ignored',
            attempts: 1,
            lastError: null,
            paymentIds: [],
            nextAttemptAt: null,
          });
          expect(row.finishedAt).toBeInstanceOf(Date);
        }
        // Other spec files write payments in parallel, so only the rows these
        // deliveries could have written are counted: a write records its inbox row.
        const [{ linkedEventCount }] = await db
          .select({ linkedEventCount: sql<number>`count(*)::int` })
          .from(paymentEvents)
          .where(inArray(paymentEvents.webhookEventId, inboxRowIds));
        expect(linkedEventCount).toBe(0);
      });
    });

    describe('retries', () => {
      it('retries a reference-less event that beats its row after about 30 s, then applies it once', async () => {
        const event = paymentWireEvent();
        const webhook = signed([event]);

        await postAndDrain([webhook]);

        const retryRow = await inboxRowFor(webhook);
        const [{ secondsUntilRetry }] = await db
          .select({
            secondsUntilRetry: sql<number>`extract(epoch from ${webhookEvents.nextAttemptAt} - clock_timestamp())::float8`,
          })
          .from(webhookEvents)
          .where(eq(webhookEvents.id, retryRow.id));
        expect(retryRow).toMatchObject({
          status: 'received',
          attempts: 1,
          lastError: `No payment for reference null or provider ref ${event.providerPaymentId} yet`,
        });
        expect(secondsUntilRetry).toBeGreaterThan(
          FIRST_RETRY_DELAY_SECONDS - RETRY_DELAY_TOLERANCE_SECONDS,
        );
        expect(secondsUntilRetry).toBeLessThanOrEqual(
          FIRST_RETRY_DELAY_SECONDS,
        );
        expect(await drain()).toBe(0);

        const payment = await insertPayment({
          providerPaymentId: event.providerPaymentId,
          status: 'pending',
        });
        await forceDue(retryRow.id);
        await drain();
        await drain();

        expect(await inboxRowById(retryRow.id)).toMatchObject({
          status: 'processed',
          attempts: 2,
          lastError: null,
          paymentIds: [payment.id],
        });
        expect((await paymentOf(payment.id)).status).toBe('succeeded');
        expect(await paymentEventsOf(payment.id)).toMatchObject([
          { toStatus: 'succeeded', webhookEventId: retryRow.id },
        ]);
      });

      it('retries a refund that beats its payment, then applies it once', async () => {
        const event = refundWireEvent();
        const webhook = signed([event]);

        await postAndDrain([webhook]);

        const retryRow = await inboxRowFor(webhook);
        expect(retryRow).toMatchObject({
          status: 'received',
          attempts: 1,
          lastError: `No payment for provider ref ${event.providerPaymentId} yet`,
        });

        const payment = await insertPayment({
          providerPaymentId: event.providerPaymentId,
          status: 'succeeded',
        });
        await forceDue(retryRow.id);
        await drain();
        await drain();

        expect(await inboxRowById(retryRow.id)).toMatchObject({
          status: 'processed',
          attempts: 2,
          paymentIds: [payment.id],
        });
        expect(await refundsOf(payment.id)).toMatchObject([
          { status: 'succeeded', amountMinor: 400 },
        ]);
        expect((await paymentOf(payment.id)).status).toBe('partially_refunded');
      });

      it(
        'fails a never-resolving event at the last attempt with one warn and then leaves it alone',
        async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation();
          const webhook = signed([paymentWireEvent()]);
          await post(webhook);
          const { id } = await inboxRowFor(webhook);

          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            await forceDue(id);
            await drain();
          }
          const failedRow = await inboxRowById(id);
          await drain();

          expect(failedRow).toMatchObject({
            status: 'failed',
            attempts: 6,
            nextAttemptAt: null,
          });
          expect(failedRow.finishedAt).toBeInstanceOf(Date);
          expect(warnsAbout(warn, id)).toHaveLength(1);
          expect(await inboxRowById(id)).toEqual(failedRow);
        },
        SLOW_TEST_TIMEOUT_MS,
      );
    });

    describe('rejected events', () => {
      it('fails a different amount at the first attempt without a retry', async () => {
        const { payment, providerPaymentId } = await rowFirstPayment(1000);
        const webhook = signed([
          paymentWireEvent({
            reference: payment.id,
            providerPaymentId,
            amountMinor: 2000,
          }),
        ]);

        await postAndDrain([webhook]);
        await drain();

        const row = await inboxRowFor(webhook);
        expect(row).toMatchObject({
          status: 'failed',
          attempts: 1,
          nextAttemptAt: null,
          lastError: `Payment ${payment.id} mismatch: stored 1000 USD, received 2000 USD`,
        });
        expect(await paymentOf(payment.id)).toMatchObject({
          status: 'created',
          providerPaymentId: null,
        });
      });

      it('fails a NUL in the provider payment id at the first attempt with the pg code and stores no NUL', async () => {
        const payment = await insertPayment();
        const webhook = signed([
          paymentWireEvent({
            reference: payment.id,
            providerPaymentId: `pay\u0000${randomUUID()}`,
          }),
        ]);

        await postAndDrain([webhook]);

        expect(await inboxRowFor(webhook)).toMatchObject({
          status: 'failed',
          attempts: 1,
          lastError: 'DrizzleQueryError 22021',
        });
        expect((await paymentOf(payment.id)).providerPaymentId).toBeNull();
      });

      it('notes a payment conflict on a processed row and keeps the stored status', async () => {
        const { payment, providerPaymentId } = await rowFirstPayment(1004);
        const expiringWebhooks = fakeProvider.buildPaymentWebhooks(
          providerPaymentId,
          new Date(),
        );
        const succeededWebhook = signed([
          paymentWireEvent({
            reference: payment.id,
            providerPaymentId,
            amountMinor: 1004,
          }),
        ]);

        await postAndDrain([...expiringWebhooks, succeededWebhook]);

        expect(await inboxRowFor(succeededWebhook)).toMatchObject({
          status: 'processed',
          paymentIds: [payment.id],
          lastError: `Payment ${payment.id} conflict: expired -> succeeded`,
        });
        for (const webhook of expiringWebhooks) {
          expect(await inboxRowFor(webhook)).toMatchObject({
            status: 'processed',
            lastError: null,
          });
        }
        expect((await paymentOf(payment.id)).status).toBe('expired');
      });

      it('keeps a refund conflict on a processed row and the money counted', async () => {
        const { payment, providerPaymentId } = await succeededRowFirstPayment();
        const refundReference = randomUUID();
        const { providerRefundId } = await fakeProvider.refund({
          reference: refundReference,
          providerPaymentId,
          amountMinor: 400,
          currency: 'USD',
        });
        const refundWebhooks = fakeProvider.buildRefundWebhooks(
          providerRefundId as string,
          new Date(),
        );
        const failedWebhook = signed([
          refundWireEvent({
            type: 'refund.failed',
            providerPaymentId,
            reference: payment.id,
            refundReference,
            providerRefundId,
          }),
        ]);

        await postAndDrain([...refundWebhooks, failedWebhook]);

        expect(await inboxRowFor(failedWebhook)).toMatchObject({
          status: 'processed',
          paymentIds: [payment.id],
          lastError: `Refund ${refundReference} conflict: succeeded -> failed`,
        });
        expect(await inboxRowFor(refundWebhooks[1])).toMatchObject({
          status: 'processed',
          lastError: null,
        });
        expect(await refundsOf(payment.id)).toMatchObject([
          { status: 'succeeded' },
        ]);
        expect((await paymentOf(payment.id)).status).toBe('partially_refunded');
      });

      it('fails a delivery with a handled and a rejected event and keeps the handled effect', async () => {
        const handled = await rowFirstPayment(1000);
        const rejected = await rowFirstPayment(1000);
        const webhook = signed([
          paymentWireEvent({
            type: 'payment.pending',
            reference: handled.payment.id,
            providerPaymentId: handled.providerPaymentId,
          }),
          paymentWireEvent({
            reference: rejected.payment.id,
            providerPaymentId: rejected.providerPaymentId,
            amountMinor: 2000,
          }),
        ]);

        await postAndDrain([webhook]);

        expect(await inboxRowFor(webhook)).toMatchObject({
          status: 'failed',
          attempts: 1,
          paymentIds: [handled.payment.id],
          lastError: expect.stringContaining(
            `Payment ${rejected.payment.id} mismatch`,
          ) as string,
        });
        expect((await paymentOf(handled.payment.id)).status).toBe('pending');
      });

      it('retries a delivery with a retryable and a rejected event', async () => {
        const rejected = await rowFirstPayment(1000);
        const webhook = signed([
          paymentWireEvent(),
          paymentWireEvent({
            reference: rejected.payment.id,
            providerPaymentId: rejected.providerPaymentId,
            amountMinor: 2000,
          }),
        ]);

        await postAndDrain([webhook]);

        expect(await inboxRowFor(webhook)).toMatchObject({
          status: 'received',
          attempts: 1,
        });
      });
    });

    describe('replay', () => {
      const replay = (id: string) => app.get(WebhooksService).replay(id);

      it('processes the stored event through a body-less replay row and leaves the original as it was', async () => {
        const { payment, providerPaymentId } = await rowFirstPayment(1000);
        const [pendingWebhook] = fakeProvider.buildPaymentWebhooks(
          providerPaymentId,
          new Date(),
        );
        await postAndDrain([pendingWebhook]);
        const original = await inboxRowFor(pendingWebhook);

        const replayId = await replay(original.id);
        const queuedReplay = await inboxRowById(replayId as string);
        await drain();

        expect(queuedReplay).toMatchObject({
          replayOf: original.id,
          dedupKey: original.dedupKey,
          rawBody: null,
          headers: {},
          status: 'received',
          attempts: 0,
        });
        expect(await inboxRowById(replayId as string)).toMatchObject({
          status: 'processed',
          paymentIds: [payment.id],
        });
        expect(await inboxRowFor(pendingWebhook)).toEqual(original);
      });

      it('recovers a failed original through a replay made after its row exists, and still dedups the key', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        const event = paymentWireEvent();
        const webhook = signed([event]);
        await post(webhook);
        const { id } = await inboxRowFor(webhook);
        await db
          .update(webhookEvents)
          .set({ attempts: MAX_ATTEMPTS - 1 })
          .where(eq(webhookEvents.id, id));
        await drain();
        const failedOriginal = await inboxRowById(id);
        const payment = await insertPayment({
          providerPaymentId: event.providerPaymentId,
          status: 'pending',
        });

        const replayId = await replay(id);
        await drain();
        await post(webhook);
        await drain();

        expect(failedOriginal).toMatchObject({ status: 'failed', attempts: 6 });
        expect(await inboxRowById(replayId as string)).toMatchObject({
          status: 'processed',
          paymentIds: [payment.id],
        });
        expect((await paymentOf(payment.id)).status).toBe('succeeded');
        expect(await paymentEventsOf(payment.id)).toMatchObject([
          { webhookEventId: replayId },
        ]);
        expect(await inboxRowById(id)).toEqual(failedOriginal);
        expect(await originalRowsFor(webhook)).toHaveLength(1);
      });

      it('points a replay of a replay at the root', async () => {
        const webhook = signed([subscriptionWireEvent()]);
        await post(webhook);
        const { id } = await inboxRowFor(webhook);

        const firstReplayId = await replay(id);
        const secondReplayId = await replay(firstReplayId as string);

        expect(await inboxRowById(secondReplayId as string)).toMatchObject({
          replayOf: id,
        });
      });

      it('refuses an invalid-signature row, an unknown id and a non-uuid', async () => {
        const rejectedBody = nonJsonBody();
        await deliverTo(app, rejectedBody, WRONG_SIGNATURE).expect(401);
        const [invalidRow] = await rowsWithKey(invalidKeyOf(rejectedBody));

        await expect(replay(invalidRow.id)).resolves.toBeNull();
        await expect(replay(randomUUID())).resolves.toBeNull();
        await expect(replay('not-a-uuid')).resolves.toBeNull();
        expect(
          await db
            .select()
            .from(webhookEvents)
            .where(eq(webhookEvents.replayOf, invalidRow.id)),
        ).toHaveLength(0);
      });
    });

    describe('enabled worker', () => {
      it(
        'processes a row a closed app left received once a new enabled app boots',
        async () => {
          const { payment, providerPaymentId } = await rowFirstPayment(1000);
          const [pendingWebhook] = fakeProvider.buildPaymentWebhooks(
            providerPaymentId,
            new Date(),
          );
          const closedApp = await createE2eApp();
          await deliverTo(
            closedApp,
            pendingWebhook.rawBody,
            closedApp.get(FakeProvider).signRawBody(pendingWebhook.rawBody)
              .headers[SIGNATURE_HEADER] as string,
          ).expect(200);
          await closedApp.close();
          const { id } = await inboxRowFor(pendingWebhook);

          const workerApp = await createE2eApp({
            isWorkerEnabled: true,
            pollIntervalMs: LONG_POLL_INTERVAL_MS,
          });
          try {
            const row = await waitForStatus(
              workerApp.get<Database>(DRIZZLE),
              id,
              'processed',
            );

            expect(row).toMatchObject({
              status: 'processed',
              paymentIds: [payment.id],
            });
          } finally {
            await workerApp.close();
          }
        },
        SLOW_TEST_TIMEOUT_MS,
      );

      it(
        'processes a POST through the kick well inside a long interval',
        async () => {
          const claimNext = jest.spyOn(
            WebhooksRepository.prototype,
            'claimNext',
          );
          const workerApp = await createE2eApp({
            isWorkerEnabled: true,
            pollIntervalMs: LONG_POLL_INTERVAL_MS,
          });
          try {
            const workerDb = workerApp.get<Database>(DRIZZLE);
            while (claimNext.mock.results.length === 0) {
              await sleep(WORKER_WAIT_POLL_MS);
            }
            await claimNext.mock.results[0].value;
            await sleep(WORKER_WAIT_POLL_MS);
            const workerProvider = workerApp.get(FakeProvider);
            const webhook = workerProvider.buildWebhook({
              eventId: randomUUID(),
              occurredAt: null,
              events: [{ type: 'some.new.type' }],
            });

            await post(webhook, workerApp);
            const { id } = await inboxRowFor(webhook, workerDb);
            const row = await waitForStatus(workerDb, id, 'ignored');

            expect(row.status).toBe('ignored');
          } finally {
            await workerApp.close();
          }
        },
        SLOW_TEST_TIMEOUT_MS,
      );
    });

    describeOnRealPostgres('claims on real Postgres', () => {
      const repository = () => app.get(WebhooksRepository);

      const warmPool = async (database: Database): Promise<void> => {
        await Promise.all(
          Array.from({ length: databasePoolMax }, () =>
            database.execute(
              sql`select pg_sleep(${POOL_WARMUP_SLEEP_SECONDS})`,
            ),
          ),
        );
      };

      it('gives two concurrent claimers different rows', async () => {
        const ids = await insertDueRows(2);
        await warmPool(db);

        const claims = await Promise.all([
          repository().claimNext(),
          repository().claimNext(),
        ]);

        expect(new Set(claims.map((claim) => claim?.id))).toEqual(new Set(ids));
      });

      it('skips a row another client holds instead of waiting on it', async () => {
        const [lockedId, freeId] = await insertDueRows(2);
        const lockClient = postgres(databaseUrl, { max: 1, prepare: false });

        try {
          const claim = await lockClient.begin(async (tx) => {
            await tx`select id from webhook_events where id = ${lockedId} for update`;

            return Promise.race([
              repository().claimNext(),
              sleep(LOCK_WAIT_DEADLINE_MS).then(() => 'blocked' as const),
            ]);
          });

          expect(claim).toMatchObject({ id: freeId, attempts: 1 });
        } finally {
          await lockClient.end({ timeout: CLIENT_END_TIMEOUT_SECONDS });
        }
      });

      it('reclaims an expired lease at attempt 2 and fences the stale finish', async () => {
        const [id] = await insertDueRows(1);
        const staleClaim = await repository().claimNext();
        await db
          .update(webhookEvents)
          .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(webhookEvents.id, id));
        const freshClaim = await repository().claimNext();

        const isStaleFinished = await repository().finish(
          staleClaim as NonNullable<typeof staleClaim>,
          { status: 'processed', lastError: null, paymentIds: [] },
        );
        const rowAfterStaleFinish = await inboxRowById(id);
        const isFreshFinished = await repository().finish(
          freshClaim as NonNullable<typeof freshClaim>,
          { status: 'ignored', lastError: null, paymentIds: [] },
        );

        expect(staleClaim).toMatchObject({ id, attempts: 1 });
        expect(freshClaim).toMatchObject({ id, attempts: 2 });
        expect(isStaleFinished).toBe(false);
        expect(rowAfterStaleFinish).toMatchObject({
          status: 'received',
          attempts: 2,
        });
        expect(isFreshFinished).toBe(true);
        expect(await inboxRowById(id)).toMatchObject({ status: 'ignored' });
      });

      it(
        'turns 20 parallel identical POSTs into one row and one transition',
        async () => {
          const workerApp = await createE2eApp({
            isWorkerEnabled: true,
            pollIntervalMs: LONG_POLL_INTERVAL_MS,
          });
          try {
            await workerApp.listen(0);
            const workerDb = workerApp.get<Database>(DRIZZLE);
            await warmPool(workerDb);
            const { payment, providerPaymentId } = await rowFirstPayment(1000);
            const [pendingWebhook] = workerApp
              .get(FakeProvider)
              .buildPaymentWebhooks(providerPaymentId, new Date());

            const responses = await Promise.all(
              Array.from({ length: PARALLEL_DELIVERIES }, () =>
                deliverTo(
                  workerApp,
                  pendingWebhook.rawBody,
                  pendingWebhook.headers[SIGNATURE_HEADER] as string,
                ),
              ),
            );
            const [{ id }, ...otherRows] = await originalRowsFor(
              pendingWebhook,
              workerDb,
            );
            const row = await waitForStatus(workerDb, id, 'processed');

            expect(responses.map(({ status }) => status)).toEqual(
              Array.from({ length: PARALLEL_DELIVERIES }, () => 200),
            );
            expect(otherRows).toHaveLength(0);
            expect(row).toMatchObject({ status: 'processed', attempts: 1 });
            expect(await paymentEventsOf(payment.id)).toMatchObject([
              { fromStatus: 'created', toStatus: 'pending' },
            ]);
          } finally {
            await workerApp.close();
          }
        },
        SLOW_TEST_TIMEOUT_MS,
      );

      it(
        'lets the worker of a second app with the same secret process what the first stored',
        async () => {
          const processEvent = jest.spyOn(
            WebhookEventProcessor.prototype,
            'process',
          );
          const sharedSecret = randomBytes(32).toString('hex');
          const receiverApp = await createE2eApp({
            fakeWebhookSecret: sharedSecret,
          });
          const workerApp = await createE2eApp({
            fakeWebhookSecret: sharedSecret,
            isWorkerEnabled: true,
            pollIntervalMs: SHORT_POLL_INTERVAL_MS,
          });
          try {
            const { payment, providerPaymentId } = await rowFirstPayment(1000);
            const [pendingWebhook] = receiverApp
              .get(FakeProvider)
              .buildPaymentWebhooks(providerPaymentId, new Date());

            await post(pendingWebhook, receiverApp);
            const { id } = await inboxRowFor(pendingWebhook);
            const row = await waitForStatus(db, id, 'processed');

            expect(row).toMatchObject({
              status: 'processed',
              paymentIds: [payment.id],
            });
            const workerProcessor = workerApp.get(WebhookEventProcessor);
            expect(processEvent.mock.contexts.length).toBeGreaterThan(0);
            expect(
              processEvent.mock.contexts.every(
                (context) => context === workerProcessor,
              ),
            ).toBe(true);
          } finally {
            await workerApp.close();
            await receiverApp.close();
          }
        },
        SLOW_TEST_TIMEOUT_MS,
      );

      it(
        'gives each of 50 rows one attempt across two draining apps',
        async () => {
          const ids = await insertDueRows(DRAINED_ROWS);
          const otherApp = await createE2eApp();
          try {
            await warmPool(db);
            await warmPool(otherApp.get<Database>(DRIZZLE));

            const drainedCounts = await Promise.all([drain(), drain(otherApp)]);

            const rows = await db
              .select()
              .from(webhookEvents)
              .where(inArray(webhookEvents.id, ids));
            expect(drainedCounts[0] + drainedCounts[1]).toBe(DRAINED_ROWS);
            expect(rows).toHaveLength(DRAINED_ROWS);
            for (const row of rows) {
              expect(row).toMatchObject({ status: 'ignored', attempts: 1 });
            }
          } finally {
            await otherApp.close();
          }
        },
        SLOW_TEST_TIMEOUT_MS,
      );
    });
  });

  describeOnRealPostgres('real Postgres concurrency', () => {
    it(
      'turns parallel deliveries of one event into one row',
      async () => {
        await Promise.all(
          Array.from({ length: databasePoolMax }, () =>
            db.execute(sql`select pg_sleep(${POOL_WARMUP_SLEEP_SECONDS})`),
          ),
        );
        const eventId = randomUUID();
        const rawBody = wireBody(eventId);

        const responses = await Promise.all(
          Array.from({ length: PARALLEL_DELIVERIES }, () => deliver(rawBody)),
        );

        expect(responses.map(({ status }) => status)).toEqual(
          Array.from({ length: PARALLEL_DELIVERIES }, () => 200),
        );
        expect(await rowsWithKey(eventId)).toHaveLength(1);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });
});
