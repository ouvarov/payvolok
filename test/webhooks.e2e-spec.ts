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
import { DrizzleQueryError, eq, inArray, sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import request from 'supertest';

import { WEBHOOK_BODY_LIMIT_BYTES } from '@/app.setup';
import { DRIZZLE, type Database } from '@/database/drizzle';
import { paymentEvents, payments } from '@/database/schemas/payments.schema';
import {
  webhookEvents,
  type NewWebhookEvent,
  type WebhookEvent,
} from '@/database/schemas/webhook-events.schema';
import { FakeProvider } from '@/providers/fake/fake.provider';
import { ProviderError } from '@/providers/payment-provider.port';
import { dedupKeyFromBody } from '@/providers/provider-events';
import { ProviderRegistry } from '@/providers/provider.registry';
import { ProvidersModule } from '@/providers/providers.module';
import { WebhooksRepository } from '@/webhooks/webhooks.repository';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import {
  createE2eApp,
  databaseCauseOf,
  databasePoolMax,
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

const failedPaymentEvent = (failureReason: string | null) => ({
  type: 'payment.failed',
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

  beforeAll(async () => {
    app = await createE2eApp();
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
    fakeProvider = app.get(FakeProvider);
  }, SLOW_TEST_TIMEOUT_MS);

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
        headers: {},
        eventTypes: [],
        failureReason: null,
        nextAttemptAt: null,
      });
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

    it('maps exactly the health and webhook routes', () => {
      const httpInstance = app.getHttpAdapter().getInstance() as {
        router: { stack: { route?: { path: string } }[] };
      };

      expect(
        httpInstance.router.stack
          .flatMap(({ route }) => (route ? [route.path] : []))
          .sort(),
      ).toEqual(['/health/live', '/health/ready', '/webhooks/:provider']);
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
