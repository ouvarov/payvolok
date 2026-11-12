import { randomInt, randomUUID } from 'node:crypto';

import { Logger, type INestApplication } from '@nestjs/common';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
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
  type NewPayment,
  type Payment,
} from '@/database/schemas/payments.schema';
import { refunds, type Refund } from '@/database/schemas/refunds.schema';
import { webhookEvents } from '@/database/schemas/webhook-events.schema';
import { IDEMPOTENCY_LEASE_SECONDS } from '@/idempotency/idempotency.constants';
import { IdempotencyRepository } from '@/idempotency/idempotency.repository';
import { PaymentsRepository } from '@/payments/payments.repository';
import { encodeFakeId } from '@/providers/fake/fake-wire-format';
import { FakeProvider } from '@/providers/fake/fake.provider';
import {
  ProviderError,
  type CreatedRefund,
  type RefundInput,
  type WebhookRequest,
} from '@/providers/payment-provider.port';
import { ProviderRegistry } from '@/providers/provider.registry';
import { UNCONFIRMED_REFUND_RECONCILE_DELAY_SECONDS } from '@/refunds/refund.constants';
import { RefundsService } from '@/refunds/refunds.service';
import { WebhookEventProcessor } from '@/webhooks/webhook-event.processor';

import {
  createE2eApp,
  databaseUrl,
  describeOnRealPostgres,
  serverOf,
  TEST_API_KEY,
  waitUntilBlockedBy,
} from './helpers';

const SIGNATURE_HEADER = 'x-fake-signature';
const REFUND_AMOUNT_MINOR = 1000;
const POLL_INTERVAL_MS = 20;
const WAIT_DEADLINE_MS = 10000;
const SLOW_TEST_TIMEOUT_MS = 60000;

const refundsPathOf = (paymentId: string): string =>
  `/${API_V1_PREFIX}/payments/${paymentId}/refunds`;

const uniqueAmountMinor = (): number => randomInt(10_000, 10_000_000) * 100;

const newKey = (): string => `e2e-${randomUUID()}`;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (isDone: () => boolean): Promise<void> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;

  while (!isDone()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await delay(POLL_INTERVAL_MS);
  }
};

describe('POST /api/v1/payments/:paymentId/refunds', () => {
  let app: INestApplication;
  let db: Database;
  let fakeProvider: FakeProvider;
  let refund: jest.SpyInstance<Promise<CreatedRefund>, [RefundInput]>;

  const realRefund = (input: RefundInput): Promise<CreatedRefund> =>
    FakeProvider.prototype.refund.call(fakeProvider, input);

  const useReferenceIdentity = () =>
    jest
      .spyOn(app.get(ProviderRegistry), 'refundIdentityOf')
      .mockReturnValue('reference');

  const postRefund = (
    paymentId: string,
    body: unknown,
    idempotencyKey?: string,
  ) => {
    const call = request(serverOf(app))
      .post(refundsPathOf(paymentId))
      .set('Authorization', `Bearer ${TEST_API_KEY}`);

    return (
      idempotencyKey === undefined
        ? call
        : call.set('Idempotency-Key', idempotencyKey)
    ).send(body as object);
  };

  const insertPayment = async (
    overrides: Partial<NewPayment> = {},
  ): Promise<Payment> => {
    const id = randomUUID();
    const amountMinor = overrides.amountMinor ?? uniqueAmountMinor();
    const [payment] = await db
      .insert(payments)
      .values({
        id,
        provider: 'fake',
        providerPaymentId: encodeFakeId({
          reference: id,
          amountMinor,
          currency: 'USD',
        }),
        purpose: 'one_off',
        origin: 'api',
        status: 'succeeded',
        currency: 'USD',
        ...overrides,
        amountMinor,
      })
      .returning();

    return payment;
  };

  const insertRefund = async (
    paymentId: string,
    status: Refund['status'],
    amountMinor: number,
  ): Promise<void> => {
    await db.insert(refunds).values({
      paymentId,
      provider: 'fake',
      providerRefundId: randomUUID(),
      origin: 'provider',
      status,
      amountMinor,
      currency: 'USD',
    });
  };

  const keyRowOf = async (key: string): Promise<IdempotencyKey | null> => {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, 'api:create_refund'),
          eq(idempotencyKeys.key, key),
        ),
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

  const refundRowsOf = (paymentId: string): Promise<Refund[]> =>
    db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, paymentId))
      .orderBy(asc(refunds.createdAt), asc(refunds.id));

  const paymentTimelineOf = async (paymentId: string) =>
    (
      await db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, paymentId))
        .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id))
    ).map(({ fromStatus, toStatus, outcome }) => [
      fromStatus,
      toStatus,
      outcome,
    ]);

  const ageKey = async (key: string, seconds: number): Promise<void> => {
    await db.execute(sql`
      update idempotency_keys
      set created_at = created_at - ${seconds}::integer * interval '1 second'
      where scope = 'api:create_refund' and key = ${key}
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

  const refundIdOf = (response: request.Response): string =>
    (response.body as { refundId: string }).refundId;

  const setReconcileAfter = async (
    paymentId: string,
    reconcileAfter: SQL,
  ): Promise<void> => {
    await db.execute(sql`
      update payments set reconcile_after = ${reconcileAfter}
      where id = ${paymentId}
    `);
  };

  const isReconciledWithin = async (
    paymentId: string,
    seconds: number,
  ): Promise<boolean> => {
    const [{ is_within: isWithin }] = await db.execute<{
      is_within: boolean;
    }>(sql`
      select coalesce(
        reconcile_after <= clock_timestamp() + ${seconds}::integer * interval '1 second',
        false
      ) as is_within
      from payments where id = ${paymentId}
    `);

    return isWithin;
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

  beforeEach(() => {
    refund = jest.spyOn(fakeProvider, 'refund');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a provider that identifies refunds by its own id', () => {
    it('answers 201 and writes one api refund only after the provider answered', async () => {
      const payment = await insertPayment();
      const key = newKey();
      let rowsDuringCall: Refund[] | null = null;
      refund.mockImplementation(async (input) => {
        rowsDuringCall = await refundRowsOf(payment.id);

        return realRefund(input);
      });

      const response = await postRefund(
        payment.id,
        { amountMinor: REFUND_AMOUNT_MINOR },
        key,
      ).expect(201);

      const refundId = refundIdOf(response);
      const created = await (refund.mock.results[0]
        .value as Promise<CreatedRefund>);
      expect(response.body).toEqual({
        refundId,
        paymentId: payment.id,
        status: 'succeeded',
      });
      expect(response.headers['idempotent-replayed']).toBeUndefined();
      expect(rowsDuringCall).toEqual([]);
      expect(refund).toHaveBeenCalledTimes(1);
      expect(refund).toHaveBeenCalledWith({
        reference: refundId,
        providerPaymentId: payment.providerPaymentId,
        amountMinor: REFUND_AMOUNT_MINOR,
        currency: 'USD',
      });
      expect(await refundRowsOf(payment.id)).toEqual([
        expect.objectContaining({
          id: refundId,
          provider: 'fake',
          providerRefundId: created.providerRefundId,
          origin: 'api',
          status: 'succeeded',
          amountMinor: REFUND_AMOUNT_MINOR,
          currency: 'USD',
        }),
      ]);
      expect((await paymentOf(payment.id))?.status).toBe('partially_refunded');
      expect(await keyRowOf(key)).toMatchObject({
        status: 'completed',
        paymentId: payment.id,
        responseStatus: 201,
        responseBody: response.body as object,
      });
    });

    it('counts the money once when the webhook lands during the provider call', async () => {
      const payment = await insertPayment();
      refund.mockImplementation(async (input) => {
        const created = await realRefund(input);
        await processSignedWebhook(
          fakeProvider.buildWebhook({
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            events: [
              {
                type: 'refund.succeeded',
                providerPaymentId: input.providerPaymentId,
                reference: null,
                refundReference: null,
                providerRefundId: created.providerRefundId,
                amountMinor: input.amountMinor,
                currency: input.currency,
              },
            ],
          }),
        );

        return created;
      });

      const response = await postRefund(
        payment.id,
        {
          amountMinor: REFUND_AMOUNT_MINOR,
        },
        newKey(),
      ).expect(201);

      const rows = await refundRowsOf(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        origin: 'provider',
        status: 'succeeded',
      });
      expect(response.body).toEqual({
        refundId: rows[0].id,
        paymentId: payment.id,
        status: 'succeeded',
      });
      expect((await paymentOf(payment.id))?.status).toBe('partially_refunded');
      expect(await paymentTimelineOf(payment.id)).toEqual([
        ['succeeded', 'partially_refunded', 'applied'],
      ]);
    });

    it('answers 503 and writes no row when the provider returns no refund id', async () => {
      const { error } = muteLogs();
      const payment = await insertPayment();
      const key = newKey();
      refund.mockResolvedValue({ providerRefundId: null, status: 'pending' });

      const response = await postRefund(
        payment.id,
        { amountMinor: REFUND_AMOUNT_MINOR },
        key,
      ).expect(503);

      expect(response.body).toEqual({
        statusCode: 503,
        code: 'provider_unavailable',
        message: expect.any(String) as string,
        paymentId: payment.id,
      });
      expect(await refundRowsOf(payment.id)).toEqual([]);
      expect(await keyRowOf(key)).toMatchObject({
        status: 'completed',
        responseStatus: 503,
      });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `of payment ${payment.id} at fake: the provider returned no refund id`,
        ),
      );
    });
  });

  describe('a provider that identifies refunds by our reference', () => {
    it('keeps a pending row during the call and links the provider id after it', async () => {
      useReferenceIdentity();
      const payment = await insertPayment();
      let rowsDuringCall: Refund[] = [];
      refund.mockImplementation(async (input) => {
        rowsDuringCall = await refundRowsOf(payment.id);

        return realRefund(input);
      });

      const response = await postRefund(
        payment.id,
        {
          amountMinor: REFUND_AMOUNT_MINOR,
        },
        newKey(),
      ).expect(201);

      const refundId = refundIdOf(response);
      const created = await (refund.mock.results[0]
        .value as Promise<CreatedRefund>);
      expect(refund).toHaveBeenCalledWith(
        expect.objectContaining({ reference: refundId }),
      );
      expect(rowsDuringCall).toEqual([
        expect.objectContaining({
          id: refundId,
          providerRefundId: null,
          origin: 'api',
          status: 'pending',
          amountMinor: REFUND_AMOUNT_MINOR,
        }),
      ]);
      expect(await refundRowsOf(payment.id)).toEqual([
        expect.objectContaining({
          id: refundId,
          providerRefundId: created.providerRefundId,
          origin: 'api',
          status: 'succeeded',
        }),
      ]);
      expect(response.body).toEqual({
        refundId,
        paymentId: payment.id,
        status: 'succeeded',
      });
    });
  });

  describe('refusals before the provider call', () => {
    const expectNothingStored = async (key: string): Promise<void> => {
      expect(await keyRowOf(key)).toBeNull();
      expect(refund).not.toHaveBeenCalled();
    };

    it('answers 404 for an unknown payment, then refunds under the same key', async () => {
      const key = newKey();

      const response = await postRefund(
        randomUUID(),
        { amountMinor: REFUND_AMOUNT_MINOR },
        key,
      ).expect(404);

      expect(response.body).toEqual({
        statusCode: 404,
        code: 'payment_not_found',
        message: 'Payment not found',
      });
      await expectNothingStored(key);
      const payment = await insertPayment();
      await postRefund(
        payment.id,
        { amountMinor: REFUND_AMOUNT_MINOR },
        key,
      ).expect(201);
    });

    it.each(['created', 'pending', 'failed', 'expired', 'refunded'] as const)(
      'answers 409 for a %s payment, then refunds under the same key once it succeeded',
      async (status) => {
        const payment = await insertPayment({ status });
        const key = newKey();
        const body = { amountMinor: REFUND_AMOUNT_MINOR };

        const response = await postRefund(payment.id, body, key).expect(409);

        expect(response.body).toEqual({
          statusCode: 409,
          code: 'payment_not_refundable',
          message: expect.any(String) as string,
        });
        await expectNothingStored(key);
        await db
          .update(payments)
          .set({ status: 'succeeded' })
          .where(eq(payments.id, payment.id));
        await postRefund(payment.id, body, key).expect(201);
      },
    );

    it('answers 409 for a succeeded payment without a provider id', async () => {
      const payment = await insertPayment({ providerPaymentId: null });
      const key = newKey();

      const response = await postRefund(
        payment.id,
        { amountMinor: REFUND_AMOUNT_MINOR },
        key,
      ).expect(409);

      expect(response.body).toEqual({
        statusCode: 409,
        code: 'payment_not_refundable',
        message: expect.any(String) as string,
      });
      await expectNothingStored(key);
    });

    it('answers 422 above what pending and succeeded refunds leave, then refunds the rest under the same key', async () => {
      const payment = await insertPayment({
        amountMinor: 10000,
        status: 'partially_refunded',
      });
      await insertRefund(payment.id, 'pending', 3000);
      await insertRefund(payment.id, 'succeeded', 3000);
      await insertRefund(payment.id, 'failed', 3000);
      const key = newKey();

      const response = await postRefund(
        payment.id,
        { amountMinor: 4001 },
        key,
      ).expect(422);

      expect(response.body).toEqual({
        statusCode: 422,
        code: 'refund_amount_exceeds_remaining',
        message: expect.any(String) as string,
      });
      await expectNothingStored(key);
      await postRefund(payment.id, { amountMinor: 4000 }, key).expect(201);
    });

    it.each([
      ['an unknown field', { amountMinor: 1000, reason: 'x' }, 'reason'],
      ['a missing amount', {}, 'amountMinor'],
      ['a string amount', { amountMinor: '1000' }, 'amountMinor'],
      ['a zero amount', { amountMinor: 0 }, 'amountMinor'],
      ['a fractional amount', { amountMinor: 10.5 }, 'amountMinor'],
    ])(
      'answers 400 validation_failed for %s, storing nothing',
      async (_case, body, field) => {
        const payment = await insertPayment();
        const key = newKey();

        const response = await postRefund(payment.id, body, key).expect(400);

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
        await expectNothingStored(key);
      },
    );

    it('answers 400 bad_request for a payment id that is not a uuid', async () => {
      const key = newKey();

      const response = await postRefund(
        'not-a-uuid',
        { amountMinor: REFUND_AMOUNT_MINOR },
        key,
      ).expect(400);

      expect(response.body).toEqual({
        statusCode: 400,
        code: 'bad_request',
        message: expect.any(String) as string,
      });
      await expectNothingStored(key);
    });

    it('answers 400 idempotency_key_required without the header', async () => {
      const payment = await insertPayment();

      const response = await postRefund(payment.id, {
        amountMinor: REFUND_AMOUNT_MINOR,
      }).expect(400);

      expect(response.body).toMatchObject({
        code: 'idempotency_key_required',
      });
      expect(refund).not.toHaveBeenCalled();
    });

    it('answers 401 without the API key, storing nothing', async () => {
      const payment = await insertPayment();
      const key = newKey();

      await request(serverOf(app))
        .post(refundsPathOf(payment.id))
        .set('Idempotency-Key', key)
        .send({ amountMinor: REFUND_AMOUNT_MINOR })
        .expect(401);

      await expectNothingStored(key);
    });
  });

  describe('a repeated key', () => {
    it('replays the stored answer with Idempotent-Replayed and refunds once', async () => {
      const payment = await insertPayment();
      const key = newKey();
      const body = { amountMinor: REFUND_AMOUNT_MINOR };
      const first = await postRefund(payment.id, body, key).expect(201);

      const replay = await postRefund(
        payment.id.toUpperCase(),
        body,
        key,
      ).expect(201);

      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await refundRowsOf(payment.id)).toHaveLength(1);
    });

    it.each([
      ['another amount', 'same', REFUND_AMOUNT_MINOR + 100],
      ['another payment', 'other', REFUND_AMOUNT_MINOR],
    ] as const)(
      'answers 422 idempotency_key_reused for %s and calls no provider',
      async (_case, target, amountMinor) => {
        const payment = await insertPayment();
        const otherPayment = await insertPayment();
        const key = newKey();
        await postRefund(
          payment.id,
          { amountMinor: REFUND_AMOUNT_MINOR },
          key,
        ).expect(201);

        const response = await postRefund(
          target === 'same' ? payment.id : otherPayment.id,
          { amountMinor },
          key,
        ).expect(422);

        expect(response.body).toEqual({
          statusCode: 422,
          code: 'idempotency_key_reused',
          message: expect.any(String) as string,
        });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(await refundRowsOf(payment.id)).toHaveLength(1);
        expect(await refundRowsOf(otherPayment.id)).toEqual([]);
      },
    );

    it('answers 409 while the first request still waits for the provider', async () => {
      const payment = await insertPayment();
      const key = newKey();
      const body = { amountMinor: REFUND_AMOUNT_MINOR };
      let concurrent: request.Response | null = null;
      refund.mockImplementation(async (input) => {
        concurrent = await postRefund(payment.id, body, key);

        return realRefund(input);
      });

      await postRefund(payment.id, body, key).expect(201);

      expect(concurrent).toMatchObject({
        status: 409,
        body: {
          statusCode: 409,
          code: 'idempotency_key_in_progress',
          message: expect.any(String) as string,
        },
      });
      expect(refund).toHaveBeenCalledTimes(1);
    });

    it('answers 409 refund_in_progress to another key while a refund of the payment waits for the provider', async () => {
      const payment = await insertPayment();
      const otherKey = newKey();
      let concurrent: request.Response | null = null;
      refund.mockImplementation(async (input) => {
        concurrent = await postRefund(
          payment.id,
          { amountMinor: REFUND_AMOUNT_MINOR },
          otherKey,
        );

        return realRefund(input);
      });

      await postRefund(
        payment.id,
        { amountMinor: REFUND_AMOUNT_MINOR },
        newKey(),
      ).expect(201);

      expect(concurrent).toMatchObject({
        status: 409,
        body: {
          statusCode: 409,
          code: 'refund_in_progress',
          message: expect.any(String) as string,
        },
      });
      expect(await keyRowOf(otherKey)).toBeNull();
      expect(refund).toHaveBeenCalledTimes(1);
    });

    it('lets another key refund once the in-progress key is past its lease', async () => {
      muteLogs();
      const payment = await insertPayment();
      const staleKey = newKey();
      jest
        .spyOn(RefundsService.prototype, 'recordApiRefund')
        .mockRejectedValueOnce(new Error('crash after the provider answered'));
      await postRefund(
        payment.id,
        { amountMinor: REFUND_AMOUNT_MINOR },
        staleKey,
      ).expect(500);
      await ageKey(staleKey, IDEMPOTENCY_LEASE_SECONDS + 1);

      await postRefund(
        payment.id,
        { amountMinor: REFUND_AMOUNT_MINOR },
        newKey(),
      ).expect(201);
    });
  });

  describe('provider failures', () => {
    const PROVIDER_REJECTED = {
      statusCode: 422,
      code: 'refund_rejected',
      message: 'The payment provider rejected the refund',
    };

    it.each([
      ['provider', 97, 'rejected', 'warn', null],
      ['provider', 98, 'unavailable', 'warn', null],
      ['provider', 99, 'misconfigured', 'error', null],
      ['reference', 97, 'rejected', 'warn', 'failed'],
      ['reference', 98, 'unavailable', 'warn', 'pending'],
      ['reference', 99, 'misconfigured', 'error', 'failed'],
    ] as const)(
      'with %s identity answers amount ending %i (%s) and leaves the row as expected',
      async (identity, suffix, kind, logLevel, rowStatus) => {
        const logs = muteLogs();
        if (identity === 'reference') useReferenceIdentity();
        const payment = await insertPayment();
        const key = newKey();

        const response = await postRefund(
          payment.id,
          { amountMinor: 1000 + suffix },
          key,
        );

        expect(response.body).toEqual(
          kind === 'rejected'
            ? PROVIDER_REJECTED
            : {
                statusCode: 503,
                code: 'provider_unavailable',
                message: 'The payment provider did not confirm the refund',
                paymentId: payment.id,
              },
        );
        expect(response.status).toBe(kind === 'rejected' ? 422 : 503);
        expect(response.text).not.toMatch(/misconfigured/i);
        expect(
          (await refundRowsOf(payment.id)).map(({ status }) => status),
        ).toEqual(rowStatus === null ? [] : [rowStatus]);
        expect((await paymentOf(payment.id))?.status).toBe('succeeded');
        expect(await keyRowOf(key)).toMatchObject({
          status: 'completed',
          responseStatus: response.status,
        });
        expect(logs[logLevel]).toHaveBeenCalledWith(
          expect.stringContaining(`failed: provider_${kind}`),
        );
      },
    );

    it('replays a stored failure without calling the provider', async () => {
      muteLogs();
      const payment = await insertPayment();
      const key = newKey();
      const body = { amountMinor: 1098 };
      const first = await postRefund(payment.id, body, key).expect(503);

      const replay = await postRefund(payment.id, body, key).expect(503);

      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(refund).toHaveBeenCalledTimes(1);
    });

    it('keeps a status the provider reported before its call failed', async () => {
      muteLogs();
      useReferenceIdentity();
      const payment = await insertPayment();
      refund.mockImplementation(async (input) => {
        const created = await realRefund(input);
        for (const webhook of fakeProvider.buildRefundWebhooks(
          created.providerRefundId as string,
          new Date(),
        )) {
          await processSignedWebhook(webhook);
        }

        throw new ProviderError('Declined after the provider accepted', {
          providerCode: 'fake',
          kind: 'rejected',
        });
      });

      const response = await postRefund(
        payment.id,
        {
          amountMinor: REFUND_AMOUNT_MINOR,
        },
        newKey(),
      ).expect(422);

      expect(response.body).toEqual(PROVIDER_REJECTED);
      expect(await refundRowsOf(payment.id)).toEqual([
        expect.objectContaining({ status: 'succeeded' }),
      ]);
      expect((await paymentOf(payment.id))?.status).toBe('partially_refunded');
    });
  });

  describe('reconciliation after a refund the provider did not confirm', () => {
    const EARLIER_DUE_AT = '2026-01-01 00:00:00.123456+00';
    const DAY_SECONDS = 24 * 60 * 60;

    it.each([
      ['an outage', 1098, false],
      ['a misconfiguration', 1099, false],
      ['no refund id', REFUND_AMOUNT_MINOR, true],
    ] as const)(
      'brings the payment check within two minutes after %s',
      async (_case, amountMinor, isRefundIdMissing) => {
        muteLogs();
        if (isRefundIdMissing) {
          refund.mockResolvedValue({
            providerRefundId: null,
            status: 'pending',
          });
        }
        const payment = await insertPayment();
        await setReconcileAfter(
          payment.id,
          sql`clock_timestamp() + ${DAY_SECONDS}::integer * interval '1 second'`,
        );

        await postRefund(payment.id, { amountMinor }, newKey()).expect(503);

        expect(
          await isReconciledWithin(
            payment.id,
            UNCONFIRMED_REFUND_RECONCILE_DELAY_SECONDS,
          ),
        ).toBe(true);
      },
    );

    it('keeps an earlier due time', async () => {
      muteLogs();
      const payment = await insertPayment();
      await setReconcileAfter(payment.id, sql`${EARLIER_DUE_AT}::timestamptz`);

      await postRefund(payment.id, { amountMinor: 1098 }, newKey()).expect(503);

      const [{ is_kept: isKept }] = await db.execute<{ is_kept: boolean }>(sql`
        select reconcile_after = ${EARLIER_DUE_AT}::timestamptz as is_kept
        from payments where id = ${payment.id}
      `);
      expect(isKept).toBe(true);
    });

    it('re-arms a payment whose reconciliation stopped', async () => {
      muteLogs();
      const payment = await insertPayment();
      await setReconcileAfter(payment.id, sql`null`);

      await postRefund(payment.id, { amountMinor: 1098 }, newKey()).expect(503);

      expect(
        await isReconciledWithin(
          payment.id,
          UNCONFIRMED_REFUND_RECONCILE_DELAY_SECONDS,
        ),
      ).toBe(true);
    });

    it('leaves the schedule after a rejection', async () => {
      muteLogs();
      const payment = await insertPayment();
      await setReconcileAfter(
        payment.id,
        sql`clock_timestamp() + ${DAY_SECONDS}::integer * interval '1 second'`,
      );

      await postRefund(payment.id, { amountMinor: 1097 }, newKey()).expect(422);

      expect(
        await isReconciledWithin(
          payment.id,
          UNCONFIRMED_REFUND_RECONCILE_DELAY_SECONDS,
        ),
      ).toBe(false);
    });
  });

  describe('interrupted requests', () => {
    it.each(['provider', 'reference'] as const)(
      'with %s identity stores 503 for a stale key without calling the provider or changing rows',
      async (identity) => {
        const { warn } = muteLogs();
        if (identity === 'reference') useReferenceIdentity();
        const payment = await insertPayment();
        const key = newKey();
        const body = { amountMinor: REFUND_AMOUNT_MINOR };
        jest
          .spyOn(RefundsService.prototype, 'recordApiRefund')
          .mockRejectedValueOnce(
            new Error('crash after the provider answered'),
          );
        await postRefund(payment.id, body, key).expect(500);
        await postRefund(payment.id, body, key).expect(409);
        const rowsBefore = await refundRowsOf(payment.id);
        const paymentBefore = await paymentOf(payment.id);
        await ageKey(key, IDEMPOTENCY_LEASE_SECONDS + 1);

        const recovered = await postRefund(payment.id, body, key).expect(503);
        const replay = await postRefund(payment.id, body, key).expect(503);

        expect(recovered.body).toEqual({
          statusCode: 503,
          code: 'provider_unavailable',
          message: expect.any(String) as string,
          paymentId: payment.id,
        });
        expect(recovered.headers['idempotent-replayed']).toBeUndefined();
        expect(replay.text).toBe(recovered.text);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(refund).toHaveBeenCalledTimes(1);
        expect(rowsBefore).toEqual(
          identity === 'reference'
            ? [
                expect.objectContaining({
                  status: 'pending',
                  providerRefundId: null,
                }),
              ]
            : [],
        );
        expect(await refundRowsOf(payment.id)).toEqual(rowsBefore);
        expect(await paymentOf(payment.id)).toEqual({
          ...paymentBefore,
          reconcileAfter: expect.any(Date) as Date,
        });
        expect(
          await isReconciledWithin(
            payment.id,
            UNCONFIRMED_REFUND_RECONCILE_DELAY_SECONDS,
          ),
        ).toBe(true);
        expect(
          warn.mock.calls.filter(([message]) =>
            String(message).includes('request was interrupted'),
          ),
        ).toEqual([[expect.stringContaining(payment.id)]]);
      },
    );

    it('keeps the refund of an owner whose lease was recovered, returns the stored 503 and warns', async () => {
      const { warn } = muteLogs();
      const payment = await insertPayment();
      const key = newKey();
      const body = { amountMinor: REFUND_AMOUNT_MINOR };
      let recovery: request.Response | null = null;
      refund.mockImplementation(async (input) => {
        await ageKey(key, IDEMPOTENCY_LEASE_SECONDS + 1);
        recovery = await postRefund(payment.id, body, key);

        return realRefund(input);
      });

      const owner = await postRefund(payment.id, body, key).expect(503);

      const refundId = refund.mock.calls[0][0].reference;
      expect(recovery).toMatchObject({ status: 503, text: owner.text });
      expect(await refundRowsOf(payment.id)).toEqual([
        expect.objectContaining({ id: refundId, status: 'succeeded' }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Refund ${refundId} of payment ${payment.id}: the provider answered after a retry recovered the request`,
        ),
      );
    });

    it.each(['provider', 'reference'] as const)(
      'with %s identity rolls back the refund with the key completion that failed after it',
      async (identity) => {
        muteLogs();
        if (identity === 'reference') useReferenceIdentity();
        const payment = await insertPayment();
        const key = newKey();
        const recordApiRefund = jest.spyOn(
          RefundsService.prototype,
          'recordApiRefund',
        );
        jest
          .spyOn(IdempotencyRepository.prototype, 'complete')
          .mockRejectedValueOnce(new Error('completion failed'));

        await postRefund(
          payment.id,
          { amountMinor: REFUND_AMOUNT_MINOR },
          key,
        ).expect(500);

        await expect(
          recordApiRefund.mock.results[0].value as Promise<unknown>,
        ).resolves.toMatchObject({
          refundOutcome: expect.any(String) as string,
        });
        expect(await refundRowsOf(payment.id)).toEqual(
          identity === 'reference'
            ? [
                expect.objectContaining({
                  status: 'pending',
                  providerRefundId: null,
                }),
              ]
            : [],
        );
        expect(await paymentOf(payment.id)).toMatchObject({
          status: 'succeeded',
        });
        expect(await paymentTimelineOf(payment.id)).toEqual([]);
        expect(await keyRowOf(key)).toMatchObject({
          status: 'in_progress',
          paymentId: payment.id,
          responseStatus: null,
        });
      },
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
      'lets one of two keys refund a payment at once and answers the other 409 refund_in_progress',
      async () => {
        const payment = await insertPayment();
        let settledCount = 0;
        let isFirstLock = true;
        let isLockWaitSeen = false;
        const paymentsRepository = app.get(PaymentsRepository);
        const findByIdForUpdate =
          paymentsRepository.findByIdForUpdate.bind(paymentsRepository);
        jest
          .spyOn(paymentsRepository, 'findByIdForUpdate')
          .mockImplementation(async (tx, paymentId) => {
            const locked = await findByIdForUpdate(tx, paymentId);
            if (isFirstLock) {
              isFirstLock = false;
              const [{ pid }] = await tx.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
              );
              isLockWaitSeen = await waitUntilBlockedBy(monitorDb, pid);
            }

            return locked;
          });
        refund.mockImplementation(async (input) => {
          await waitFor(() => settledCount === 1);

          return realRefund(input);
        });

        const responses = await Promise.all(
          [newKey(), newKey()].map((key) =>
            postRefund(
              payment.id,
              { amountMinor: REFUND_AMOUNT_MINOR },
              key,
            ).then((response) => {
              settledCount += 1;
              return response;
            }),
          ),
        );

        const [created, refused] = [...responses].sort(
          (left, right) => left.status - right.status,
        );
        expect(isLockWaitSeen).toBe(true);
        expect(created.status).toBe(201);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'refund_in_progress' });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(await refundRowsOf(payment.id)).toEqual([
          expect.objectContaining({ id: refundIdOf(created) }),
        ]);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });
});
