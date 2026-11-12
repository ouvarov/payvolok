import { randomInt, randomUUID } from 'node:crypto';

import { Logger, type INestApplication } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type Payment,
} from '@/database/schemas/payments.schema';
import { refunds, type Refund } from '@/database/schemas/refunds.schema';
import {
  adjustmentListFixture,
  adjustmentResponseFixture,
  syntheticPaddleId,
  transactionResponseFixture,
  type PaddleAdjustmentFixture,
} from '@/providers/paddle/fixtures/paddle-fixtures';
import { PaddleProvider } from '@/providers/paddle/paddle.provider';
import { REFUNDABLE_RECONCILE_DELAY_SECONDS } from '@/reconciliation/reconciliation.constants';
import { ReconciliationWorker } from '@/reconciliation/reconciliation.worker';

import { createE2eApp, serverOf, TEST_API_KEY } from './helpers';
import { scopedReconciliation } from './scoped-reconciliation';

type FetchHandler = (init: RequestInit | undefined) => Promise<Response>;

type ListedAdjustment = Partial<
  Pick<PaddleAdjustmentFixture, 'action' | 'status' | 'subscription_id'>
> & { id?: string; totalMinor?: number };

const API_KEY = `pdl_sdbx_apikey_${'e2e1'.repeat(13)}`;
const WEBHOOK_SECRET = 'pdl_ntfset_01jce2esecret000000000000002_E2eSecret';
const FIXED_NOW_EPOCH_MS = 1_762_855_200_000;
const PADDLE_API = 'https://sandbox-api.paddle.com';
const SLOW_TEST_TIMEOUT_MS = 60000;
const HOUR_SECONDS = 60 * 60;
const REFUND_AMOUNT_MINOR = 400;

const { paymentIds, override } = scopedReconciliation();

const uniqueAmountMinor = (): number => randomInt(10_000, 10_000_000) * 100;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const refundListPath = (transactionId: string): string =>
  `${PADDLE_API}/adjustments?transaction_id=${transactionId}&action=refund&per_page=50`;

const adjustmentOf = (
  transactionId: string,
  {
    id = syntheticPaddleId('adj'),
    totalMinor = REFUND_AMOUNT_MINOR,
    ...fields
  }: ListedAdjustment,
): PaddleAdjustmentFixture => {
  const [template] = adjustmentListFixture().data;

  return {
    ...template,
    ...fields,
    id,
    transaction_id: transactionId,
    totals: { ...template.totals, total: String(totalMinor) },
  };
};

const secondsScheduledAfterCheck = (payment: Payment): number | null =>
  payment.reconcileAfter === null || payment.reconciledAt === null
    ? null
    : (payment.reconcileAfter.getTime() - payment.reconciledAt.getTime()) /
      1000;

const muteLogs = () => ({
  warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
  error: jest.spyOn(Logger.prototype, 'error').mockImplementation(),
  log: jest.spyOn(Logger.prototype, 'log').mockImplementation(),
});

describe('Reconciliation of Paddle refunds', () => {
  const fetchHandlers = new Map<string, FetchHandler>();
  const stubFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>(
    (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const key = `${init?.method ?? 'GET'} ${url}`;
      const handler = fetchHandlers.get(key);
      if (!handler) throw new Error(`Unexpected Paddle request ${key}`);

      return handler(init);
    },
  );

  let app: INestApplication;
  let db: Database;
  let worker: ReconciliationWorker;

  const stubCompletedTransaction = (
    transactionId: string,
    amountMinor: number,
  ): void => {
    const transaction = transactionResponseFixture('transaction-completed');
    transaction.data.id = transactionId;
    transaction.data.details.totals.total = String(amountMinor);
    transaction.data.details.totals.grand_total = String(amountMinor);
    fetchHandlers.set(`GET ${PADDLE_API}/transactions/${transactionId}`, () =>
      Promise.resolve(jsonResponse(transaction)),
    );
  };

  const stubRefundList = (
    transactionId: string,
    adjustments: ListedAdjustment[],
    hasMore = false,
  ): void => {
    const fixture = adjustmentListFixture();
    fetchHandlers.set(`GET ${refundListPath(transactionId)}`, () =>
      Promise.resolve(
        jsonResponse({
          ...fixture,
          data: adjustments.map((adjustment) =>
            adjustmentOf(transactionId, adjustment),
          ),
          meta: {
            ...fixture.meta,
            pagination: { ...fixture.meta.pagination, has_more: hasMore },
          },
        }),
      ),
    );
  };

  const insertDueSucceededPayment = async (
    amountMinor = uniqueAmountMinor(),
  ): Promise<Payment> => {
    const [payment] = await db
      .insert(payments)
      .values({
        provider: 'paddle',
        providerPaymentId: syntheticPaddleId('txn'),
        purpose: 'one_off',
        origin: 'api',
        status: 'succeeded',
        amountMinor,
        currency: 'USD',
        createdAt: sql`clock_timestamp() - ${HOUR_SECONDS}::integer * interval '1 second'`,
        reconcileAfter: sql`clock_timestamp() - interval '1 second'`,
      })
      .returning();
    paymentIds.add(payment.id);
    stubCompletedTransaction(payment.providerPaymentId as string, amountMinor);

    return payment;
  };

  const makeDue = async (paymentId: string): Promise<void> => {
    await db.execute(sql`
      update payments
      set reconcile_after = clock_timestamp() - interval '1 second'
      where id = ${paymentId}
    `);
  };

  const paymentOf = async (paymentId: string): Promise<Payment> => {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment;
  };

  const refundRowsOf = (paymentId: string): Promise<Refund[]> =>
    db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, paymentId))
      .orderBy(asc(refunds.createdAt), asc(refunds.id));

  const refundVersionsOf = async (paymentId: string): Promise<string[]> =>
    (
      await db.execute<{ version: string }>(sql`
        select xmin::text as version from refunds
        where payment_id = ${paymentId} order by id
      `)
    ).map(({ version }) => version);

  const timelineOf = async (paymentId: string) =>
    (
      await db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, paymentId))
        .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id))
    ).map(({ fromStatus, toStatus, outcome, reason, webhookEventId }) => [
      fromStatus,
      toStatus,
      outcome,
      reason,
      webhookEventId,
    ]);

  const insertApiRefund = async (
    payment: Payment,
    providerRefundId: string,
  ): Promise<Refund> => {
    const [refund] = await db
      .insert(refunds)
      .values({
        paymentId: payment.id,
        provider: 'paddle',
        providerRefundId,
        origin: 'api',
        status: 'pending',
        amountMinor: REFUND_AMOUNT_MINOR,
        currency: 'USD',
      })
      .returning();

    return refund;
  };

  beforeAll(async () => {
    app = await createE2eApp({
      classOverrides: [override],
      paddleEnv: {
        PADDLE_API_KEY: API_KEY,
        PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      paddleProvider: new PaddleProvider(
        { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET },
        stubFetch,
        () => FIXED_NOW_EPOCH_MS,
      ),
    });
    db = app.get<Database>(DRIZZLE);
    worker = app.get(ReconciliationWorker);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    paymentIds.clear();
  });

  afterEach(() => {
    fetchHandlers.clear();
    stubFetch.mockClear();
    jest.restoreAllMocks();
  });

  describe('a refund found only at Paddle', () => {
    it.each([
      ['part', REFUND_AMOUNT_MINOR, 'partially_refunded'],
      ['all', null, 'refunded'],
    ] as const)(
      'records an approved refund of %s of the payment once',
      async (_case, refundMinor, paymentStatus) => {
        const { warn } = muteLogs();
        const payment = await insertDueSucceededPayment();
        const transactionId = payment.providerPaymentId as string;
        const adjustmentId = syntheticPaddleId('adj');
        stubRefundList(transactionId, [
          {
            id: adjustmentId,
            status: 'approved',
            totalMinor: refundMinor ?? payment.amountMinor,
          },
        ]);

        await worker.drain();

        expect(await refundRowsOf(payment.id)).toEqual([
          expect.objectContaining({
            provider: 'paddle',
            providerRefundId: adjustmentId,
            origin: 'provider',
            status: 'succeeded',
            amountMinor: refundMinor ?? payment.amountMinor,
          }),
        ]);
        expect((await paymentOf(payment.id)).status).toBe(paymentStatus);
        expect(await timelineOf(payment.id)).toEqual([
          ['succeeded', paymentStatus, 'applied', 'reconciliation', null],
        ]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('found only at the provider'),
        );
        const versions = await refundVersionsOf(payment.id);

        await makeDue(payment.id);
        await worker.drain();

        expect(await refundVersionsOf(payment.id)).toEqual(versions);
        expect(await timelineOf(payment.id)).toHaveLength(1);
      },
    );

    it('stops checking a payment its refunds refunded in full', async () => {
      muteLogs();
      const payment = await insertDueSucceededPayment();
      stubRefundList(payment.providerPaymentId as string, [
        { status: 'approved', totalMinor: payment.amountMinor },
      ]);

      await worker.drain();

      expect((await paymentOf(payment.id)).reconcileAfter).toBeNull();
    });
  });

  describe('a refund we asked for', () => {
    it('settles a pending refund Paddle approved', async () => {
      muteLogs();
      const payment = await insertDueSucceededPayment();
      const adjustmentId = syntheticPaddleId('adj');
      const refund = await insertApiRefund(payment, adjustmentId);
      stubRefundList(payment.providerPaymentId as string, [
        { id: adjustmentId, status: 'approved' },
      ]);

      await worker.drain();

      expect(await refundRowsOf(payment.id)).toEqual([
        expect.objectContaining({ id: refund.id, status: 'succeeded' }),
      ]);
      expect((await paymentOf(payment.id)).status).toBe('partially_refunded');
    });

    it(
      'fails a pending refund Paddle rejected and accepts a new refund of the whole amount',
      async () => {
        muteLogs();
        const payment = await insertDueSucceededPayment();
        const transactionId = payment.providerPaymentId as string;
        const adjustmentId = syntheticPaddleId('adj');
        const refund = await insertApiRefund(payment, adjustmentId);
        stubRefundList(transactionId, [
          { id: adjustmentId, status: 'rejected' },
        ]);

        await worker.drain();

        expect(await refundRowsOf(payment.id)).toEqual([
          expect.objectContaining({ id: refund.id, status: 'failed' }),
        ]);
        expect((await paymentOf(payment.id)).status).toBe('succeeded');

        const newAdjustmentId = syntheticPaddleId('adj');
        fetchHandlers.set(`POST ${PADDLE_API}/adjustments`, () => {
          const adjustment = adjustmentResponseFixture();
          adjustment.data.id = newAdjustmentId;
          adjustment.data.transaction_id = transactionId;
          adjustment.data.totals.total = String(payment.amountMinor);

          return Promise.resolve(jsonResponse(adjustment, 201));
        });

        const response = await request(serverOf(app))
          .post(`/${API_V1_PREFIX}/payments/${payment.id}/refunds`)
          .set('Authorization', `Bearer ${TEST_API_KEY}`)
          .set('Idempotency-Key', `e2e-${randomUUID()}`)
          .send({ amountMinor: payment.amountMinor })
          .expect(201);

        expect(response.body).toMatchObject({
          paymentId: payment.id,
          status: 'pending',
        });
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('what the list holds', () => {
    it('skips a reversed refund, a credit and a subscription refund, and records the rest', async () => {
      muteLogs();
      const payment = await insertDueSucceededPayment();
      const adjustmentId = syntheticPaddleId('adj');
      stubRefundList(payment.providerPaymentId as string, [
        { status: 'reversed' },
        { action: 'credit', status: 'approved' },
        {
          status: 'approved',
          subscription_id: 'sub_01jcsyntheticsubscription',
        },
        { id: adjustmentId, status: 'approved' },
      ]);

      await worker.drain();

      expect(await refundRowsOf(payment.id)).toEqual([
        expect.objectContaining({
          providerRefundId: adjustmentId,
          status: 'succeeded',
        }),
      ]);
    });

    it('fails the check as unavailable with no writes when the list has more pages', async () => {
      muteLogs();
      const payment = await insertDueSucceededPayment();
      stubRefundList(
        payment.providerPaymentId as string,
        [{ status: 'approved' }],
        true,
      );
      const next = await insertDueSucceededPayment();
      await db.execute(sql`
        update payments set reconcile_after = clock_timestamp()
        where id = ${next.id}
      `);

      await worker.drain();

      expect(await refundRowsOf(payment.id)).toEqual([]);
      expect(await timelineOf(payment.id)).toEqual([]);
      const stored = await paymentOf(payment.id);
      expect(stored.status).toBe('succeeded');
      expect(secondsScheduledAfterCheck(stored)).toBe(
        REFUNDABLE_RECONCILE_DELAY_SECONDS,
      );
      expect((await paymentOf(next.id)).reconcileAttempts).toBe(0);
    });
  });
});
