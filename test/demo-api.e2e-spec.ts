import { randomInt, randomUUID } from 'node:crypto';

import { Logger, type INestApplication } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { API_DEMO_PREFIX, API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  idempotencyKeys,
  type IdempotencyKey,
} from '@/database/schemas/idempotency-keys.schema';
import {
  paymentEvents,
  payments,
  type Payment,
} from '@/database/schemas/payments.schema';
import { demoTokenOf } from '@/demo/demo-token';
import { IDEMPOTENCY_LEASE_SECONDS } from '@/idempotency/idempotency.constants';
import { PaymentsService } from '@/payments/payments.service';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import { FakeProvider } from '@/providers/fake/fake.provider';
import { ReconciliationWorker } from '@/reconciliation/reconciliation.worker';

import { createE2eApp, serverOf, TEST_API_KEY } from './helpers';
import { scopedReconciliation } from './scoped-reconciliation';

const DEMO_PAYMENTS_PATH = `/${API_DEMO_PREFIX}/payments`;
const V1_PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const DEMO_TOKEN_SECRET = process.env.DEMO_TOKEN_SECRET as string;
const DEMO_RETURN_URL = `${process.env.WEB_ORIGIN}/?checkout=returned`;
const V1_RETURN_URL = 'https://shop.example.test/return';
const DEMO_TOKEN_PATTERN = /^pvd_[A-Za-z0-9_-]{43}$/;
const PAYMENT_RESPONSE_FIELDS = [
  'amountMinor',
  'createdAt',
  'currency',
  'paymentId',
  'provider',
  'status',
  'updatedAt',
];
const CREATE_LIMIT_PER_HOUR = 5;
const READ_LIMIT_PER_MINUTE = 120;
const V1_READS = 100;
const V1_READ_BATCH = 10;
const SLOW_TEST_TIMEOUT_MS = 60000;

type CreatedDemoBody = {
  paymentId: string;
  checkout: { type: string; url: string };
  demoToken: string;
};

const { paymentIds: testPaymentIds, override: TEST_SCOPED_RECONCILIATION } =
  scopedReconciliation();

let lastClientNumber = 0;

// One address per call, so no test spends another test's per-IP allowance.
const newClientIp = (): string => {
  lastClientNumber += 1;

  return `198.18.${Math.floor(lastClientNumber / 256)}.${lastClientNumber % 256}`;
};

const newKey = (): string => `e2e-demo-${randomUUID()}`;

const demoBodyWith = (overrides: Record<string, unknown> = {}) => ({
  provider: 'fake',
  amountMinor: 1000,
  ...overrides,
});

const muteLogs = () => ({
  log: jest.spyOn(Logger.prototype, 'log').mockImplementation(),
  warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
  error: jest.spyOn(Logger.prototype, 'error').mockImplementation(),
});

describe('Demo API', () => {
  let app: INestApplication;
  let db: Database;
  let fakeAdapter: FakeProvider;
  let createPayment: jest.SpyInstance;

  const postDemo = (
    body: object,
    idempotencyKey: string | null = newKey(),
    forwardedFor = newClientIp(),
    target: INestApplication = app,
  ) => {
    const call = request(serverOf(target))
      .post(DEMO_PAYMENTS_PATH)
      .set('X-Forwarded-For', forwardedFor);

    return (
      idempotencyKey === null
        ? call
        : call.set('Idempotency-Key', idempotencyKey)
    ).send(body);
  };

  const getDemo = (
    paymentId: string,
    demoToken: string | undefined,
    forwardedFor = newClientIp(),
  ) => {
    const call = request(serverOf(app))
      .get(`${DEMO_PAYMENTS_PATH}/${paymentId}`)
      .set('X-Forwarded-For', forwardedFor);

    return demoToken === undefined
      ? call
      : call.set('Authorization', `Bearer ${demoToken}`);
  };

  const postV1 = (idempotencyKey: string) =>
    request(serverOf(app))
      .post(V1_PAYMENTS_PATH)
      .set('Authorization', `Bearer ${TEST_API_KEY}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        provider: 'fake',
        amountMinor: 1000,
        currency: 'USD',
        description: 'e2e order',
        returnUrl: V1_RETURN_URL,
      });

  const createDemoPayment = async (): Promise<CreatedDemoBody> =>
    (await postDemo(demoBodyWith()).expect(201)).body as CreatedDemoBody;

  const paymentOf = async (paymentId: string): Promise<Payment> => {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment;
  };

  const keyRowOf = async (
    key: string,
    scope: IdempotencyKey['scope'] = 'demo:create_payment',
  ): Promise<IdempotencyKey | null> => {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)),
      );

    return row ?? null;
  };

  const ageDemoPayment = async (paymentId: string, seconds: number) => {
    await db.execute(sql`
      update payments
      set created_at = created_at - ${seconds}::integer * interval '1 second'
      where id = ${paymentId}
    `);
  };

  const recentDemoCount = async (): Promise<number> => {
    const [{ count }] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from payments
      where origin = 'demo' and created_at > clock_timestamp() - interval '24 hours'
    `);

    return count;
  };

  beforeAll(async () => {
    app = await createE2eApp({
      trustProxyHops: 1,
      classOverrides: [TEST_SCOPED_RECONCILIATION],
    });
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
    fakeAdapter = app.get(FakeProvider);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    testPaymentIds.clear();
    createPayment = jest.spyOn(fakeAdapter, 'createPayment');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/demo/payments', () => {
    it('answers 201 with a token and stores a demo payment of the seed project with the fixed fields', async () => {
      const key = newKey();

      const response = await postDemo(
        { provider: 'fake', amountMinor: 2500 },
        key,
      ).expect(201);

      const body = response.body as CreatedDemoBody;
      expect(body).toEqual({
        paymentId: expect.any(String) as string,
        checkout: { type: 'redirect', url: DEMO_RETURN_URL },
        demoToken: expect.stringMatching(DEMO_TOKEN_PATTERN) as string,
      });
      expect(response.headers['idempotent-replayed']).toBeUndefined();
      expect(createPayment).toHaveBeenCalledTimes(1);
      expect(createPayment).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          reference: body.paymentId,
          amountMinor: 2500,
          currency: 'USD',
          description: 'PayVolok demo payment',
          returnUrl: DEMO_RETURN_URL,
        }),
      );
      expect(await paymentOf(body.paymentId)).toMatchObject({
        projectId: SEED_PROJECT_ID,
        provider: 'fake',
        origin: 'demo',
        status: 'pending',
        amountMinor: 2500,
        currency: 'USD',
      });
      expect(await keyRowOf(key)).toMatchObject({
        projectId: SEED_PROJECT_ID,
        status: 'completed',
        paymentId: body.paymentId,
        responseStatus: 201,
      });
    });

    it('takes stripe through to the account check, which the disabled e2e seed account refuses', async () => {
      const key = newKey();

      const response = await postDemo(
        demoBodyWith({ provider: 'stripe' }),
        key,
      ).expect(422);

      expect(response.body).toMatchObject({ code: 'provider_not_available' });
      expect(await keyRowOf(key)).toBeNull();
    });

    it.each([
      ['a currency', { currency: 'EUR' }, 'currency'],
      ['a description', { description: 'mine' }, 'description'],
      ['a returnUrl', { returnUrl: 'https://evil.test/' }, 'returnUrl'],
      ['an unknown field', { projectId: SEED_PROJECT_ID }, 'projectId'],
      ['an amount off the presets', { amountMinor: 1234 }, 'amountMinor'],
      ['a string amount', { amountMinor: '1000' }, 'amountMinor'],
      ['an unknown provider', { provider: 'monobank' }, 'provider'],
    ])(
      'answers 400 validation_failed for %s, storing nothing',
      async (_case, overrides, field) => {
        const key = newKey();

        const response = await postDemo(demoBodyWith(overrides), key).expect(
          400,
        );

        expect(response.body).toMatchObject({
          statusCode: 400,
          code: 'validation_failed',
          issues: [expect.objectContaining({ field })],
        });
        expect(createPayment).not.toHaveBeenCalled();
        expect(await keyRowOf(key)).toBeNull();
      },
    );

    it('answers 400 idempotency_key_required without a key', async () => {
      const response = await postDemo(demoBodyWith(), null).expect(400);

      expect(response.body).toMatchObject({ code: 'idempotency_key_required' });
      expect(createPayment).not.toHaveBeenCalled();
    });

    it('replays the same answer and token with Idempotent-Replayed, calling the provider once', async () => {
      const key = newKey();
      const first = await postDemo(demoBodyWith(), key).expect(201);

      const replay = await postDemo(demoBodyWith(), key).expect(201);

      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(createPayment).toHaveBeenCalledTimes(1);
    });

    it('answers 422 idempotency_key_reused for another amount under the same key', async () => {
      const key = newKey();
      await postDemo(demoBodyWith(), key).expect(201);

      const response = await postDemo(
        demoBodyWith({ amountMinor: 500 }),
        key,
      ).expect(422);

      expect(response.body).toMatchObject({ code: 'idempotency_key_reused' });
      expect(createPayment).toHaveBeenCalledTimes(1);
    });

    it('keeps a key string used on /api/v1 apart from the same string on the demo route', async () => {
      const key = newKey();
      const v1 = await postV1(key).expect(201);

      const demo = await postDemo(demoBodyWith(), key).expect(201);
      const demoReplay = await postDemo(demoBodyWith(), key).expect(201);
      const v1Replay = await postV1(key).expect(201);

      const v1PaymentId = (v1.body as { paymentId: string }).paymentId;
      const demoPaymentId = (demo.body as CreatedDemoBody).paymentId;
      expect(demoPaymentId).not.toBe(v1PaymentId);
      expect(demo.headers['idempotent-replayed']).toBeUndefined();
      expect(demoReplay.text).toBe(demo.text);
      expect(v1Replay.text).toBe(v1.text);
      expect((await paymentOf(v1PaymentId)).origin).toBe('api');
      expect((await paymentOf(demoPaymentId)).origin).toBe('demo');
      expect(await keyRowOf(key, 'api:create_payment')).toMatchObject({
        paymentId: v1PaymentId,
      });
      expect(await keyRowOf(key)).toMatchObject({ paymentId: demoPaymentId });
    });

    it('never stores the token or writes it to a log', async () => {
      const logs = muteLogs();
      const key = newKey();

      const created = (await postDemo(demoBodyWith(), key).expect(201))
        .body as CreatedDemoBody;
      await getDemo(created.paymentId, created.demoToken).expect(200);

      const keyRow = await keyRowOf(key);
      expect(keyRow?.responseBody).toEqual({
        paymentId: created.paymentId,
        checkout: created.checkout,
      });
      const [{ holding }] = await db.execute<{ holding: number }>(sql`
        select count(*)::int as holding from idempotency_keys
        where response_body::text like ${`%${created.demoToken}%`}
      `);
      expect(holding).toBe(0);
      const logged = Object.values(logs)
        .flatMap((spy) => spy.mock.calls)
        .map((call) => JSON.stringify(call));
      expect(logged).toContainEqual(
        expect.stringContaining(`Demo payment ${created.paymentId} created`),
      );
      expect(logged.filter((line) => line.includes(created.demoToken))).toEqual(
        [],
      );
    });
  });

  describe('GET /api/demo/payments/:paymentId', () => {
    it('answers 200 with exactly the payment response fields for its token', async () => {
      const created = await createDemoPayment();

      const response = await getDemo(
        created.paymentId,
        created.demoToken,
      ).expect(200);

      expect(Object.keys(response.body as object).sort()).toEqual(
        PAYMENT_RESPONSE_FIELDS,
      );
      expect(response.body).toMatchObject({
        paymentId: created.paymentId,
        status: 'pending',
        provider: 'fake',
        amountMinor: 1000,
        currency: 'USD',
      });
    });

    it('brings the reconciliation of a pending payment at least 30 s old forward', async () => {
      const created = await createDemoPayment();
      await ageDemoPayment(created.paymentId, 31);

      await getDemo(created.paymentId, created.demoToken).expect(200);

      const [{ isDue }] = await db.execute<{ isDue: boolean }>(sql`
        select reconcile_after <= clock_timestamp() as "isDue"
        from payments where id = ${created.paymentId}
      `);
      expect(isDue).toBe(true);
    });

    it.each([
      ['no token', () => undefined],
      ['a malformed token', () => 'not-a-token'],
      [
        'another demo payment token',
        (_paymentId: string, otherToken: string) => otherToken,
      ],
    ])('answers 404 payment_not_found for %s', async (_case, tokenFor) => {
      const created = await createDemoPayment();
      const other = await createDemoPayment();

      const response = await getDemo(
        created.paymentId,
        tokenFor(created.paymentId, other.demoToken),
      ).expect(404);

      expect(response.body).toEqual({
        statusCode: 404,
        code: 'payment_not_found',
        message: 'Payment not found',
      });
    });

    it('answers 404 for a correct HMAC of an api payment', async () => {
      const v1 = await postV1(newKey()).expect(201);
      const paymentId = (v1.body as { paymentId: string }).paymentId;

      const response = await getDemo(
        paymentId,
        demoTokenOf(DEMO_TOKEN_SECRET, paymentId),
      ).expect(404);

      expect(response.body).toMatchObject({ code: 'payment_not_found' });
    });

    it('answers 404 for a demo payment 25 h old', async () => {
      const created = await createDemoPayment();
      await ageDemoPayment(created.paymentId, 25 * 60 * 60);

      const response = await getDemo(
        created.paymentId,
        created.demoToken,
      ).expect(404);

      expect(response.body).toMatchObject({ code: 'payment_not_found' });
    });
  });

  describe('per-IP limits', () => {
    it('answers the 6th create in an hour from one client 429 rate_limited, whatever it forges to the left', async () => {
      const clientIp = newClientIp();
      const forgedFor = () => `${randomInt(1, 224)}.0.0.1, ${clientIp}`;
      for (let attempt = 0; attempt < CREATE_LIMIT_PER_HOUR; attempt += 1) {
        await postDemo({}, newKey(), forgedFor()).expect(400);
      }

      const limited = await postDemo(demoBodyWith(), newKey(), forgedFor());
      const otherClient = await postDemo(demoBodyWith(), newKey());

      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Too many requests',
      });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(otherClient.status).toBe(201);
    });

    it(
      'answers the 121st read in a minute from one client 429 and never limits /api/v1',
      async () => {
        const clientIp = newClientIp();
        const paymentId = randomUUID();
        const statuses: number[] = [];
        for (let attempt = 0; attempt <= READ_LIMIT_PER_MINUTE; attempt += 1) {
          statuses.push(
            (await getDemo(paymentId, 'pvd_wrong', clientIp)).status,
          );
        }

        const v1Responses: request.Response[] = [];
        for (let batch = 0; batch < V1_READS / V1_READ_BATCH; batch += 1) {
          v1Responses.push(
            ...(await Promise.all(
              Array.from({ length: V1_READ_BATCH }, () =>
                request(serverOf(app))
                  .get(`${V1_PAYMENTS_PATH}/${paymentId}`)
                  .set('Authorization', `Bearer ${TEST_API_KEY}`)
                  .set('X-Forwarded-For', clientIp),
              ),
            )),
          );
        }

        expect(statuses.slice(0, READ_LIMIT_PER_MINUTE)).toEqual(
          Array.from({ length: READ_LIMIT_PER_MINUTE }, () => 404),
        );
        expect(statuses.at(-1)).toBe(429);
        expect(v1Responses.map(({ status }) => status)).toEqual(
          Array.from({ length: V1_READS }, () => 404),
        );
        expect(
          v1Responses.filter(({ headers }) => 'x-ratelimit-limit' in headers),
        ).toEqual([]);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('the daily limit', () => {
    let limitedApp: INestApplication | null = null;

    afterEach(async () => {
      await limitedApp?.close();
      limitedApp = null;
    });

    it(
      'answers 429 demo_limit_reached with Retry-After once the 24 h demo count reaches the limit, creating nothing',
      async () => {
        const olderDemo = await createDemoPayment();
        await ageDemoPayment(olderDemo.paymentId, 25 * 60 * 60);
        await postV1(newKey()).expect(201);
        const baseline = await recentDemoCount();
        limitedApp = await createE2eApp({
          demoDailyPaymentLimit: baseline + 2,
        });
        const limitedProvider = jest.spyOn(
          limitedApp.get(FakeProvider),
          'createPayment',
        );
        const clientIp = newClientIp();

        await postDemo(demoBodyWith(), newKey(), clientIp, limitedApp).expect(
          201,
        );
        await postDemo(demoBodyWith(), newKey(), clientIp, limitedApp).expect(
          201,
        );
        muteLogs();
        const refused = await postDemo(
          demoBodyWith(),
          newKey(),
          clientIp,
          limitedApp,
        ).expect(429);

        expect(refused.body).toEqual({
          statusCode: 429,
          code: 'demo_limit_reached',
          message: expect.any(String) as string,
        });
        const retryAfterSeconds = Number(refused.headers['retry-after']);
        expect(retryAfterSeconds).toBeGreaterThan(0);
        expect(retryAfterSeconds).toBeLessThanOrEqual(24 * 60 * 60);
        expect(limitedProvider).toHaveBeenCalledTimes(2);
        expect(await recentDemoCount()).toBe(baseline + 2);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'refuses every create with limit 0 and logs the X-Forwarded-For count without addresses',
      async () => {
        const { log } = muteLogs();
        limitedApp = await createE2eApp({ demoDailyPaymentLimit: 0 });
        const limitedProvider = jest.spyOn(
          limitedApp.get(FakeProvider),
          'createPayment',
        );
        const before = await recentDemoCount();

        const refused = await postDemo(
          demoBodyWith(),
          newKey(),
          '192.0.2.7, 198.51.100.9',
          limitedApp,
        ).expect(429);
        await postDemo(demoBodyWith(), newKey(), undefined, limitedApp).expect(
          429,
        );

        expect(refused.body).toMatchObject({ code: 'demo_limit_reached' });
        expect(limitedProvider).not.toHaveBeenCalled();
        expect(await recentDemoCount()).toBe(before);
        const hopLines = log.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes('X-Forwarded-For'));
        expect(hopLines).toEqual([
          'First demo request carried 2 X-Forwarded-For entries',
        ]);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('an interrupted demo request', () => {
    it('is closed by reconciliation in the demo scope: failed, and its key stores 503', async () => {
      muteLogs();
      const key = newKey();
      jest
        .spyOn(PaymentsService.prototype, 'recordCreated')
        .mockRejectedValueOnce(new Error('crash after the provider answered'));
      await postDemo(demoBodyWith(), key).expect(500);
      const paymentId = (await keyRowOf(key))?.paymentId as string;
      testPaymentIds.add(paymentId);
      await db.execute(sql`
        update idempotency_keys
        set created_at = created_at - ${IDEMPOTENCY_LEASE_SECONDS + 1}::integer * interval '1 second'
        where scope = 'demo:create_payment' and key = ${key}
      `);
      await db.execute(sql`
        update payments set reconcile_after = clock_timestamp() - interval '1 second'
        where id = ${paymentId}
      `);

      await app.get(ReconciliationWorker).drain();

      expect((await paymentOf(paymentId)).status).toBe('failed');
      const timeline = await db
        .select({ reason: paymentEvents.reason })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, paymentId))
        .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));
      expect(timeline.at(-1)).toEqual({ reason: 'reconciliation_interrupted' });
      expect(await keyRowOf(key)).toMatchObject({
        status: 'completed',
        responseStatus: 503,
        responseBody: {
          statusCode: 503,
          code: 'provider_unavailable',
          message: expect.any(String) as string,
          paymentId,
        },
      });
    });
  });
});
