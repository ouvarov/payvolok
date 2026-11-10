import { randomInt, randomUUID } from 'node:crypto';

import { Logger, type INestApplication } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
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
import { webhookEvents } from '@/database/schemas/webhook-events.schema';
import {
  IDEMPOTENCY_KEY_TTL_SECONDS,
  IDEMPOTENCY_LEASE_SECONDS,
} from '@/idempotency/idempotency.constants';
import { IdempotencyRepository } from '@/idempotency/idempotency.repository';
import { PaymentsRepository } from '@/payments/payments.repository';
import { PaymentsService } from '@/payments/payments.service';
import { FakeProvider } from '@/providers/fake/fake.provider';
import {
  ProviderError,
  type CreatedPayment,
  type CreatePaymentInput,
  type WebhookRequest,
} from '@/providers/payment-provider.port';
import { WebhookEventProcessor } from '@/webhooks/webhook-event.processor';

import {
  createE2eApp,
  databasePoolMax,
  databaseUrl,
  describeOnRealPostgres,
  serverOf,
  TEST_API_KEY,
  waitUntilBlockedBy,
} from './helpers';

const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const RETURN_URL = 'https://shop.example.test/return';
const EXPECTED_WEBHOOK_URL = 'https://payvolok.e2e.test/webhooks/fake';
const SIGNATURE_HEADER = 'x-fake-signature';
const LEAK_MARKER = 'LEAKMARKER';
const PARALLEL_REQUESTS = 20;
const POLL_INTERVAL_MS = 20;
const WAIT_DEADLINE_MS = 10000;
const POOL_QUERY_DEADLINE_MS = 5000;
const SLOW_TEST_TIMEOUT_MS = 60000;

type PaymentBody = {
  provider: string;
  amountMinor: number;
  currency: string;
  description: string;
  returnUrl: string;
};

const uniqueAmountMinor = (suffix = 0): number =>
  randomInt(10_000, 10_000_000) * 100 + suffix;

const paymentBodyWith = (
  overrides: Record<string, unknown> = {},
): PaymentBody => ({
  provider: 'fake',
  amountMinor: uniqueAmountMinor(),
  currency: 'USD',
  description: 'e2e order',
  returnUrl: RETURN_URL,
  ...(overrides as Partial<PaymentBody>),
});

const newKey = (): string => `e2e-${randomUUID()}`;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isSettledWithin = async (
  work: PromiseLike<unknown>,
  ms: number,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  try {
    return await Promise.race([
      Promise.resolve(work).then(() => true),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const waitFor = async (isDone: () => boolean): Promise<void> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;

  while (!isDone()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await delay(POLL_INTERVAL_MS);
  }
};

describe('POST /api/v1/payments', () => {
  let app: INestApplication;
  let db: Database;
  let fakeProvider: FakeProvider;
  let createPayment: jest.SpyInstance<
    Promise<CreatedPayment>,
    [CreatePaymentInput]
  >;

  const realCreatePayment = (
    input: CreatePaymentInput,
  ): Promise<CreatedPayment> =>
    FakeProvider.prototype.createPayment.call(fakeProvider, input);

  const postPayment = (
    body: unknown,
    idempotencyKey?: string,
    target: INestApplication = app,
  ) => {
    const call = request(serverOf(target))
      .post(PAYMENTS_PATH)
      .set('Authorization', `Bearer ${TEST_API_KEY}`);

    return (
      idempotencyKey === undefined
        ? call
        : call.set('Idempotency-Key', idempotencyKey)
    ).send(body as object);
  };

  const keyRowOf = async (
    key: string,
    scope: IdempotencyKey['scope'] = 'api:create_payment',
  ): Promise<IdempotencyKey | null> => {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)),
      );

    return row ?? null;
  };

  const paymentOf = async (paymentId: string): Promise<Payment | null> => {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment ?? null;
  };

  const paymentIdsWithAmount = async (amountMinor: number): Promise<string[]> =>
    (
      await db
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.amountMinor, amountMinor))
    ).map(({ id }) => id);

  const timelineOf = async (paymentId: string) =>
    (
      await db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, paymentId))
        .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id))
    ).map(({ fromStatus, toStatus, outcome, reason }) => [
      fromStatus,
      toStatus,
      outcome,
      reason,
    ]);

  const ageKey = async (key: string, seconds: number): Promise<void> => {
    await db.execute(sql`
      update idempotency_keys
      set created_at = created_at - ${seconds}::integer * interval '1 second'
      where scope = 'api:create_payment' and key = ${key}
    `);
  };

  const processSignedWebhook = async (
    webhook: WebhookRequest,
  ): Promise<void> => {
    expect(await fakeProvider.verifyWebhook(webhook)).toBe(true);
    const headers = {
      [SIGNATURE_HEADER]: webhook.headers[SIGNATURE_HEADER] as string,
    };
    const [{ id }] = await db
      .insert(webhookEvents)
      .values({
        provider: 'fake',
        dedupKey: fakeProvider.parseWebhook(webhook)[0].dedupKey,
        status: 'processed',
        signatureValid: true,
        rawBody: webhook.rawBody,
        headers,
        finishedAt: sql`clock_timestamp()`,
      })
      .returning({ id: webhookEvents.id });

    const finish = await app
      .get(WebhookEventProcessor)
      .process(
        { id, provider: 'fake', replayOf: null, attempts: 1 },
        { rawBody: webhook.rawBody, headers },
      );

    expect(finish.status).toBe('processed');
  };

  const muteLogs = () => ({
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
    error: jest.spyOn(Logger.prototype, 'error').mockImplementation(),
  });

  // Listening up front: a request made from inside another must not start a second listener.
  beforeAll(async () => {
    app = await createE2eApp();
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
    fakeProvider = app.get(FakeProvider);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    createPayment = jest.spyOn(fakeProvider, 'createPayment');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a first request', () => {
    it('answers 201 with the checkout and leaves a pending payment', async () => {
      const key = newKey();
      const body = paymentBodyWith();

      const response = await postPayment(body, key).expect(201);

      const paymentId = (response.body as { paymentId: string }).paymentId;
      const created = await (createPayment.mock.results[0]
        .value as Promise<CreatedPayment>);
      expect(response.body).toEqual({
        paymentId,
        checkout: { type: 'redirect', url: RETURN_URL },
      });
      expect(response.headers['idempotent-replayed']).toBeUndefined();
      expect(createPayment).toHaveBeenCalledTimes(1);
      expect(createPayment).toHaveBeenCalledWith({
        reference: paymentId,
        amountMinor: body.amountMinor,
        currency: 'USD',
        description: 'e2e order',
        returnUrl: RETURN_URL,
        webhookUrl: EXPECTED_WEBHOOK_URL,
      });
      expect(await paymentOf(paymentId)).toMatchObject({
        provider: 'fake',
        providerPaymentId: created.providerPaymentId,
        purpose: 'one_off',
        origin: 'api',
        status: 'pending',
        amountMinor: body.amountMinor,
        currency: 'USD',
      });
      expect(await timelineOf(paymentId)).toEqual([
        [null, 'created', 'applied', 'api_request'],
        ['created', 'pending', 'applied', 'provider_created'],
      ]);
      expect(await keyRowOf(key)).toMatchObject({
        status: 'completed',
        paymentId,
        responseStatus: 201,
        responseBody: response.body as object,
      });
    });

    it.each([
      ['pending', 1, 'pending', [['created', 'pending', 'applied']]],
      [
        'succeeded',
        2,
        'succeeded',
        [
          ['created', 'pending', 'applied'],
          ['pending', 'succeeded', 'applied'],
          ['succeeded', 'pending', 'stale'],
        ],
      ],
    ])(
      'keeps the row when a %s webhook lands before the provider answer',
      async (_case, webhookCount, finalStatus, laterEvents) => {
        const body = paymentBodyWith();
        let providerPaymentId = '';
        createPayment.mockImplementation(async (input) => {
          const created = await realCreatePayment(input);
          providerPaymentId = created.providerPaymentId;
          const webhooks = fakeProvider
            .buildPaymentWebhooks(created.providerPaymentId, new Date())
            .slice(0, webhookCount);
          for (const webhook of webhooks) await processSignedWebhook(webhook);

          return created;
        });

        const response = await postPayment(body, newKey()).expect(201);

        const paymentId = (response.body as { paymentId: string }).paymentId;
        expect(response.body).toEqual({
          paymentId,
          checkout: { type: 'redirect', url: RETURN_URL },
        });
        expect(await paymentIdsWithAmount(body.amountMinor)).toEqual([
          paymentId,
        ]);
        expect(await paymentOf(paymentId)).toMatchObject({
          providerPaymentId,
          status: finalStatus,
        });
        expect(
          (await timelineOf(paymentId)).map((event) => event.slice(0, 3)),
        ).toEqual([[null, 'created', 'applied'], ...laterEvents]);
      },
    );
  });

  describe('the Idempotency-Key header', () => {
    it.each([
      ['missing', undefined, 'idempotency_key_required'],
      ['empty', '', 'idempotency_key_invalid'],
      ['holding a space', 'two words', 'idempotency_key_invalid'],
      [
        'longer than 255 characters',
        'k'.repeat(256),
        'idempotency_key_invalid',
      ],
      ['not ASCII', 'café', 'idempotency_key_invalid'],
    ])('answers 400 when %s', async (_case, key, code) => {
      const response = await postPayment(paymentBodyWith(), key).expect(400);

      expect(response.body).toEqual({
        statusCode: 400,
        code,
        message: expect.any(String) as string,
      });
      expect(createPayment).not.toHaveBeenCalled();
      if (key !== undefined) expect(await keyRowOf(key)).toBeNull();
    });

    it('accepts 255 printable characters', async () => {
      const key = `${randomUUID()}!~`.padEnd(255, 'k');

      await postPayment(paymentBodyWith(), key).expect(201);

      expect(await keyRowOf(key)).toMatchObject({ status: 'completed' });
    });

    it('answers 401 before reading the key, storing nothing', async () => {
      const key = newKey();

      await request(serverOf(app))
        .post(PAYMENTS_PATH)
        .set('Idempotency-Key', key)
        .send(paymentBodyWith())
        .expect(401);

      expect(await keyRowOf(key)).toBeNull();
    });
  });

  describe('body validation', () => {
    it.each([
      ['an unknown field', { unexpectedField: 1 }, 'unexpectedField'],
      ['an unknown provider', { provider: 'other' }, 'provider'],
      ['a string amount', { amountMinor: '1000' }, 'amountMinor'],
      ['a zero amount', { amountMinor: 0 }, 'amountMinor'],
      ['a fractional amount', { amountMinor: 10.5 }, 'amountMinor'],
      ['a lowercase currency', { currency: 'usd' }, 'currency'],
      ['an empty description', { description: '' }, 'description'],
      [
        'a returnUrl that is not a URL',
        { returnUrl: 'not a url' },
        'returnUrl',
      ],
      ['a non-http returnUrl', { returnUrl: 'ftp://x.test/a' }, 'returnUrl'],
    ])(
      'answers 400 validation_failed for %s, storing nothing',
      async (_case, overrides, field) => {
        const key = newKey();

        const response = await postPayment(
          paymentBodyWith(overrides),
          key,
        ).expect(400);

        expect(response.body).toEqual({
          statusCode: 400,
          code: 'validation_failed',
          message: 'Request validation failed',
          issues: [
            {
              field,
              messages: expect.arrayContaining([
                expect.any(String),
              ]) as string[],
            },
          ],
        });
        expect(createPayment).not.toHaveBeenCalled();
        expect(await keyRowOf(key)).toBeNull();
      },
    );

    it('answers 400 validation_failed for an array body', async () => {
      const key = newKey();

      const response = await postPayment([paymentBodyWith()], key).expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'validation_failed',
        message: 'Request validation failed',
      });
      expect(
        (response.body as { issues: unknown[] }).issues.length,
      ).toBeGreaterThan(0);
      expect(createPayment).not.toHaveBeenCalled();
      expect(await keyRowOf(key)).toBeNull();
    });
  });

  describe('a repeated key', () => {
    it('replays the same body with Idempotent-Replayed, also for reordered fields', async () => {
      const key = newKey();
      const body = paymentBodyWith();
      const first = await postPayment(body, key).expect(201);

      const repeated = await postPayment(body, key).expect(201);
      const reordered = await request(serverOf(app))
        .post(PAYMENTS_PATH)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .set('Idempotency-Key', key)
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            returnUrl: body.returnUrl,
            description: body.description,
            currency: body.currency,
            amountMinor: body.amountMinor,
            provider: body.provider,
          }),
        )
        .expect(201);

      for (const replay of [repeated, reordered]) {
        expect(replay.text).toBe(first.text);
        expect(replay.headers['idempotent-replayed']).toBe('true');
      }
      expect(createPayment).toHaveBeenCalledTimes(1);
      expect(await paymentIdsWithAmount(body.amountMinor)).toHaveLength(1);
    });

    it('answers 422 idempotency_key_reused for another body and calls no provider', async () => {
      const key = newKey();
      await postPayment(paymentBodyWith(), key).expect(201);
      const otherBody = paymentBodyWith();

      const response = await postPayment(otherBody, key).expect(422);

      expect(response.body).toEqual({
        statusCode: 422,
        code: 'idempotency_key_reused',
        message: expect.any(String) as string,
      });
      expect(response.headers['idempotent-replayed']).toBeUndefined();
      expect(createPayment).toHaveBeenCalledTimes(1);
      expect(await paymentIdsWithAmount(otherBody.amountMinor)).toHaveLength(0);
    });

    it('does not collide with the same key in the refund scope', async () => {
      const key = newKey();
      const refundKeyRow = {
        scope: 'api:create_refund',
        key,
        requestHash: 'a'.repeat(64),
        status: 'in_progress',
      } as const;
      await db.insert(idempotencyKeys).values(refundKeyRow);

      await postPayment(paymentBodyWith(), key).expect(201);

      expect(await keyRowOf(key, 'api:create_refund')).toMatchObject({
        ...refundKeyRow,
        paymentId: null,
      });
      expect(await keyRowOf(key)).toMatchObject({ status: 'completed' });
    });

    it('answers 409 while the first request still waits for the provider', async () => {
      const key = newKey();
      const body = paymentBodyWith();
      let concurrent: request.Response | null = null;
      createPayment.mockImplementation(async (input) => {
        concurrent = await postPayment(body, key);

        return realCreatePayment(input);
      });

      await postPayment(body, key).expect(201);

      expect(concurrent).toMatchObject({
        status: 409,
        body: {
          statusCode: 409,
          code: 'idempotency_key_in_progress',
          message: expect.any(String) as string,
        },
      });
      expect(createPayment).toHaveBeenCalledTimes(1);
    });

    it('takes over a key past its TTL as a new request', async () => {
      const key = newKey();
      const body = paymentBodyWith();
      const first = await postPayment(body, key).expect(201);
      await ageKey(key, IDEMPOTENCY_KEY_TTL_SECONDS + 1);

      const second = await postPayment(body, key).expect(201);

      const firstPaymentId = (first.body as { paymentId: string }).paymentId;
      const secondPaymentId = (second.body as { paymentId: string }).paymentId;
      expect(secondPaymentId).not.toBe(firstPaymentId);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(createPayment).toHaveBeenCalledTimes(2);
      expect(await keyRowOf(key)).toMatchObject({
        status: 'completed',
        paymentId: secondPaymentId,
      });
    });
  });

  describe('provider failures', () => {
    const failedPaymentIdOf = async (key: string): Promise<string> =>
      (await keyRowOf(key))?.paymentId as string;

    it.each([
      [97, 'rejected', 'warn'],
      [98, 'unavailable', 'warn'],
      [99, 'misconfigured', 'error'],
    ] as const)(
      'fails the row for an amount ending %i (%s)',
      async (suffix, kind, logLevel) => {
        const logs = muteLogs();
        const key = newKey();

        const response = await postPayment(
          paymentBodyWith({ amountMinor: uniqueAmountMinor(suffix) }),
          key,
        );

        const paymentId = await failedPaymentIdOf(key);
        expect(response.body).toEqual(
          kind === 'rejected'
            ? {
                statusCode: 422,
                code: 'order_rejected',
                message: expect.any(String) as string,
              }
            : {
                statusCode: 503,
                code: 'provider_unavailable',
                message: expect.any(String) as string,
                paymentId,
              },
        );
        expect(response.status).toBe(kind === 'rejected' ? 422 : 503);
        expect(response.text).not.toMatch(/misconfigured/i);
        expect((await paymentOf(paymentId))?.status).toBe('failed');
        expect((await timelineOf(paymentId)).at(-1)).toEqual([
          'created',
          'failed',
          'applied',
          `provider_${kind}: Fake ${kind} failure chosen by the amount`,
        ]);
        expect(logs[logLevel]).toHaveBeenCalledWith(
          expect.stringContaining(
            `${paymentId} failed at fake: provider_${kind}`,
          ),
        );
      },
    );

    it('answers 503 for an error that is not a ProviderError, storing only its class', async () => {
      muteLogs();
      const key = newKey();
      createPayment.mockRejectedValue(
        new TypeError(`socket closed ${LEAK_MARKER}`),
      );

      const response = await postPayment(paymentBodyWith(), key).expect(503);

      const paymentId = await failedPaymentIdOf(key);
      expect(response.body).toEqual({
        statusCode: 503,
        code: 'provider_unavailable',
        message: expect.any(String) as string,
        paymentId,
      });
      expect(response.text).not.toContain(LEAK_MARKER);
      expect((await timelineOf(paymentId)).at(-1)).toEqual([
        'created',
        'failed',
        'applied',
        'provider_unavailable: TypeError',
      ]);
    });

    it('replays a stored failure without calling the provider; a new key calls again', async () => {
      muteLogs();
      const key = newKey();
      const body = paymentBodyWith({ amountMinor: uniqueAmountMinor(98) });
      const first = await postPayment(body, key).expect(503);

      const replay = await postPayment(body, key).expect(503);
      const withNewKey = await postPayment(body, newKey()).expect(503);

      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(createPayment).toHaveBeenCalledTimes(2);
      expect((withNewKey.body as { paymentId: string }).paymentId).not.toBe(
        (first.body as { paymentId: string }).paymentId,
      );
      expect(await paymentIdsWithAmount(body.amountMinor)).toHaveLength(2);
    });
  });

  describe('interrupted requests', () => {
    it('answers 500, then 409, then a stored 503 after the lease, with one provider call', async () => {
      muteLogs();
      const key = newKey();
      const body = paymentBodyWith();
      jest
        .spyOn(PaymentsService.prototype, 'recordCreated')
        .mockRejectedValueOnce(new Error('crash after the provider answered'));

      await postPayment(body, key).expect(500);
      await postPayment(body, key).expect(409);
      await ageKey(key, IDEMPOTENCY_LEASE_SECONDS + 1);
      const recovered = await postPayment(body, key).expect(503);
      const replay = await postPayment(body, key).expect(503);

      const paymentId = (await keyRowOf(key))?.paymentId as string;
      expect(recovered.body).toEqual({
        statusCode: 503,
        code: 'provider_unavailable',
        message: expect.any(String) as string,
        paymentId,
      });
      expect(recovered.headers['idempotent-replayed']).toBeUndefined();
      expect(replay.text).toBe(recovered.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(createPayment).toHaveBeenCalledTimes(1);
      expect((await paymentOf(paymentId))?.status).toBe('failed');
      expect(await timelineOf(paymentId)).toEqual([
        [null, 'created', 'applied', 'api_request'],
        ['created', 'failed', 'applied', 'request_interrupted'],
      ]);
    });

    it('logs the interruption once, only after the recovery committed', async () => {
      const { warn } = muteLogs();
      const key = newKey();
      const body = paymentBodyWith();
      const interruptionWarnings = () =>
        warn.mock.calls.filter(([message]) =>
          String(message).includes('request was interrupted'),
        );
      jest
        .spyOn(PaymentsService.prototype, 'recordCreated')
        .mockRejectedValueOnce(new Error('crash after the provider answered'));
      jest
        .spyOn(IdempotencyRepository.prototype, 'complete')
        .mockRejectedValueOnce(new Error('recovery could not be stored'));
      await postPayment(body, key).expect(500);
      await ageKey(key, IDEMPOTENCY_LEASE_SECONDS + 1);

      await postPayment(body, key).expect(500);
      const failedRecoveryWarnings = interruptionWarnings().length;
      const recovered = await postPayment(body, key).expect(503);
      await postPayment(body, key).expect(503);

      const paymentId = (recovered.body as { paymentId: string }).paymentId;
      expect(failedRecoveryWarnings).toBe(0);
      expect(interruptionWarnings()).toEqual([
        [expect.stringContaining(paymentId)],
      ]);
    });

    it('lets an owner whose lease was recovered keep its writes and return the stored 503', async () => {
      muteLogs();
      const key = newKey();
      const body = paymentBodyWith();
      let recovery: request.Response | null = null;
      let keyAfterRecovery: IdempotencyKey | null = null;
      let providerPaymentId = '';
      createPayment.mockImplementation(async (input) => {
        await ageKey(key, IDEMPOTENCY_LEASE_SECONDS + 1);
        recovery = await postPayment(body, key);
        keyAfterRecovery = await keyRowOf(key);
        const created = await realCreatePayment(input);
        providerPaymentId = created.providerPaymentId;

        return created;
      });

      const owner = await postPayment(body, key).expect(503);

      const paymentId = (owner.body as { paymentId: string }).paymentId;
      expect(recovery).toMatchObject({ status: 503, text: owner.text });
      expect(await keyRowOf(key)).toEqual(keyAfterRecovery);
      expect(keyAfterRecovery).toMatchObject({
        status: 'completed',
        responseStatus: 503,
        paymentId,
      });
      expect(await paymentOf(paymentId)).toMatchObject({
        providerPaymentId,
        status: 'failed',
      });
      expect(await timelineOf(paymentId)).toEqual([
        [null, 'created', 'applied', 'api_request'],
        ['created', 'failed', 'applied', 'request_interrupted'],
        ['failed', 'pending', 'stale', 'provider_created'],
      ]);
      expect(createPayment).toHaveBeenCalledTimes(1);
    });

    it('keeps a pending status a webhook set when the lease is recovered', async () => {
      muteLogs();
      const key = newKey();
      const body = paymentBodyWith();
      let recovery: request.Response | null = null;
      createPayment.mockImplementation(async (input) => {
        const created = await realCreatePayment(input);
        const [pendingWebhook] = fakeProvider.buildPaymentWebhooks(
          created.providerPaymentId,
          new Date(),
        );
        await processSignedWebhook(pendingWebhook);
        await ageKey(key, IDEMPOTENCY_LEASE_SECONDS + 1);
        recovery = await postPayment(body, key);

        return created;
      });

      const owner = await postPayment(body, key).expect(503);

      const paymentId = (owner.body as { paymentId: string }).paymentId;
      expect(owner.body).toEqual({
        statusCode: 503,
        code: 'provider_unavailable',
        message: 'The payment provider did not confirm the payment',
        paymentId,
      });
      expect(recovery).toMatchObject({ status: 503, text: owner.text });
      expect(await keyRowOf(key)).toMatchObject({
        status: 'completed',
        responseStatus: 503,
      });
      expect((await paymentOf(paymentId))?.status).toBe('pending');
      expect(await timelineOf(paymentId)).toEqual([
        [null, 'created', 'applied', 'api_request'],
        ['created', 'pending', 'applied', 'payment.pending'],
        ['pending', 'failed', 'stale', 'request_interrupted'],
      ]);
    });

    it('keeps a pending status a webhook set when the provider call then fails', async () => {
      muteLogs();
      createPayment.mockImplementation(async (input) => {
        const created = await realCreatePayment(input);
        const [pendingWebhook] = fakeProvider.buildPaymentWebhooks(
          created.providerPaymentId,
          new Date(),
        );
        await processSignedWebhook(pendingWebhook);

        throw new ProviderError('Timed out after the provider accepted', {
          providerCode: 'fake',
          kind: 'unavailable',
        });
      });

      const response = await postPayment(paymentBodyWith(), newKey()).expect(
        503,
      );

      const paymentId = (response.body as { paymentId: string }).paymentId;
      expect((await paymentOf(paymentId))?.status).toBe('pending');
      expect((await timelineOf(paymentId)).at(-1)).toEqual([
        'pending',
        'failed',
        'stale',
        'provider_unavailable: Timed out after the provider accepted',
      ]);
    });

    it('leaves neither key nor payment when the first transaction fails', async () => {
      muteLogs();
      const key = newKey();
      const body = paymentBodyWith();
      jest
        .spyOn(IdempotencyRepository.prototype, 'setPaymentId')
        .mockRejectedValueOnce(new Error('failure inside the claim'));

      await postPayment(body, key).expect(500);

      expect(await keyRowOf(key)).toBeNull();
      expect(await paymentIdsWithAmount(body.amountMinor)).toHaveLength(0);
      expect(createPayment).not.toHaveBeenCalled();
      await postPayment(body, key).expect(201);
    });
  });

  describe('connections', () => {
    it(
      'holds no connection while the provider is called, on a pool of one',
      async () => {
        const singleConnectionApp =
          databasePoolMax === 1
            ? app
            : await createE2eApp({ appDatabasePoolMax: 1 });
        if (singleConnectionApp !== app) await singleConnectionApp.listen(0);
        const singleConnectionDb = singleConnectionApp.get<Database>(DRIZZLE);
        const provider = singleConnectionApp.get(FakeProvider);
        const queryAnswers: boolean[] = [];
        jest
          .spyOn(provider, 'createPayment')
          .mockImplementation(async (input) => {
            queryAnswers.push(
              await isSettledWithin(
                singleConnectionDb.execute(sql`select 1`),
                POOL_QUERY_DEADLINE_MS,
              ),
            );

            return FakeProvider.prototype.createPayment.call(provider, input);
          });

        try {
          await postPayment(
            paymentBodyWith(),
            newKey(),
            singleConnectionApp,
          ).expect(201);
        } finally {
          if (singleConnectionApp !== app) await singleConnectionApp.close();
        }

        expect(queryAnswers).toEqual([true]);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describeOnRealPostgres('concurrency', () => {
    let monitorClient: postgres.Sql;
    let monitorDb: Database;

    beforeAll(() => {
      monitorClient = postgres(databaseUrl, { max: 1, prepare: false });
      monitorDb = drizzle(monitorClient);
    });

    afterAll(async () => {
      await monitorClient.end();
    });

    it(
      'turns 20 parallel identical requests into one payment, one call, one 201 and 409s',
      async () => {
        const key = newKey();
        const body = paymentBodyWith();
        let settledCount = 0;
        let isClaimWaitSeen = false;
        const paymentsRepository = app.get(PaymentsRepository);
        const insertIfAbsent =
          paymentsRepository.insertIfAbsent.bind(paymentsRepository);
        jest
          .spyOn(paymentsRepository, 'insertIfAbsent')
          .mockImplementation(async (tx, row) => {
            const [{ pid }] = await tx.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            isClaimWaitSeen = await waitUntilBlockedBy(monitorDb, pid);

            return insertIfAbsent(tx, row);
          });
        createPayment.mockImplementation(async (input) => {
          await waitFor(() => settledCount === PARALLEL_REQUESTS - 1);

          return realCreatePayment(input);
        });

        const responses = await Promise.all(
          Array.from({ length: PARALLEL_REQUESTS }, () =>
            postPayment(body, key).then((response) => {
              settledCount += 1;
              return response;
            }),
          ),
        );

        const statuses = responses.map(({ status }) => status).sort();
        expect(isClaimWaitSeen).toBe(true);
        expect(statuses).toEqual([
          201,
          ...Array.from({ length: PARALLEL_REQUESTS - 1 }, () => 409),
        ]);
        expect(createPayment).toHaveBeenCalledTimes(1);
        expect(await paymentIdsWithAmount(body.amountMinor)).toEqual([
          (
            responses.find(({ status }) => status === 201)?.body as {
              paymentId: string;
            }
          ).paymentId,
        ]);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });
});
