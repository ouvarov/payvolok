import { Logger, type INestApplication } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type Payment,
} from '@/database/schemas/payments.schema';
import { refunds, type Refund } from '@/database/schemas/refunds.schema';
import {
  errorBodyFixture,
  paymentIntentFixture,
  refundFixture,
  refundListFixture,
  sessionFixture,
  syntheticStripeId,
  type StripeRefundFixture,
  type StripeSessionFixture,
} from '@/providers/stripe/fixtures/stripe-fixtures';
import { StripeProvider } from '@/providers/stripe/stripe.provider';
import { REFUNDABLE_RECONCILE_DELAY_SECONDS } from '@/reconciliation/reconciliation.constants';
import { ReconciliationWorker } from '@/reconciliation/reconciliation.worker';

import { createE2eApp, seedColumnsOf } from './helpers';
import { scopedReconciliation } from './scoped-reconciliation';

type FetchHandler = (url: URL) => Promise<Response>;

type DuePaymentInput = {
  status?: Payment['status'];
  dueAgoSeconds?: number;
};

const SECRET_KEY = `sk_test_${'E2eRec0'.repeat(14)}`;
const WEBHOOK_SECRET = 'whsec_E2eSyntheticSecret00000000000002';
const FIXED_NOW_EPOCH_MS = 1_762_855_200_000;
const STRIPE_API = 'https://api.stripe.com';
const AMOUNT_MINOR = 734;
const REFUND_AMOUNT_MINOR = 200;
const HOUR_SECONDS = 60 * 60;
const SLOW_TEST_TIMEOUT_MS = 60000;

const { paymentIds, override } = scopedReconciliation();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_e2e' },
  });

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

describe('Reconciliation of Stripe payments and refunds', () => {
  const fetchHandlers = new Map<string, FetchHandler>();
  const stubFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>(
    (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const key = `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`;
      const handler = fetchHandlers.get(key);
      if (!handler) throw new Error(`Unexpected Stripe request ${key}`);

      return handler(url);
    },
  );

  let app: INestApplication;
  let db: Database;
  let worker: ReconciliationWorker;

  const insertDuePayment = async ({
    status = 'pending',
    dueAgoSeconds = 1,
  }: DuePaymentInput = {}): Promise<Payment> => {
    const [payment] = await db
      .insert(payments)
      .values({
        ...seedColumnsOf('stripe'),
        provider: 'stripe',
        providerPaymentId: syntheticStripeId('cs_test'),
        purpose: 'one_off',
        origin: 'api',
        status,
        amountMinor: AMOUNT_MINOR,
        currency: 'USD',
        createdAt: sql`clock_timestamp() - ${HOUR_SECONDS}::integer * interval '1 second'`,
        reconcileAfter: sql`clock_timestamp() - ${dueAgoSeconds}::integer * interval '1 second'`,
      })
      .returning();
    paymentIds.add(payment.id);

    return payment;
  };

  const stubSession = (
    payment: Payment,
    overrides: Partial<StripeSessionFixture>,
  ): void => {
    fetchHandlers.set(
      `GET ${STRIPE_API}/v1/checkout/sessions/${payment.providerPaymentId}`,
      () =>
        Promise.resolve(
          jsonResponse(
            sessionFixture({
              id: payment.providerPaymentId as string,
              client_reference_id: payment.id,
              ...overrides,
            }),
          ),
        ),
    );
  };

  const stubPaidSession = (payment: Payment): string => {
    const paymentIntentId = syntheticStripeId('pi');
    stubSession(payment, {
      status: 'complete',
      payment_status: 'paid',
      payment_intent: paymentIntentFixture({
        id: paymentIntentId,
        status: 'succeeded',
      }),
    });

    return paymentIntentId;
  };

  const stubRefundList = (
    paymentIntentId: string,
    listed: Partial<StripeRefundFixture>[],
    hasMore = false,
  ): void => {
    fetchHandlers.set(`GET ${STRIPE_API}/v1/refunds`, (url) => {
      if (url.searchParams.get('payment_intent') !== paymentIntentId) {
        throw new Error(`Unexpected refund list ${url.search}`);
      }

      return Promise.resolve(
        jsonResponse(
          refundListFixture(
            listed.map((refund) =>
              refundFixture({ payment_intent: paymentIntentId, ...refund }),
            ),
            hasMore,
          ),
        ),
      );
    });
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
    ).map(({ fromStatus, toStatus, outcome, reason }) => [
      fromStatus,
      toStatus,
      outcome,
      reason,
    ]);

  beforeAll(async () => {
    app = await createE2eApp({
      classOverrides: [override],
      stripeEnv: {
        STRIPE_SECRET_KEY: SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stripeProvider: new StripeProvider(stubFetch, () => FIXED_NOW_EPOCH_MS),
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

  describe('a payment', () => {
    it('reads the session with its payment intent expanded and backs an open one off', async () => {
      muteLogs();
      const payment = await insertDuePayment();
      stubSession(payment, { status: 'open', payment_status: 'unpaid' });

      await worker.drain();

      const [url] = stubFetch.mock.calls[0];
      const requested = new URL(url as string);
      expect(requested.pathname).toBe(
        `/v1/checkout/sessions/${payment.providerPaymentId}`,
      );
      expect(requested.searchParams.getAll('expand[]')).toEqual([
        'payment_intent',
      ]);
      const stored = await paymentOf(payment.id);
      expect(stored.status).toBe('pending');
      expect(stored.reconcileAttempts).toBe(1);
      expect(secondsScheduledAfterCheck(stored)).toBeGreaterThan(0);
      expect(await timelineOf(payment.id)).toEqual([]);
    });

    it('applies a paid session as succeeded with the reason reconciliation', async () => {
      muteLogs();
      const payment = await insertDuePayment();
      stubRefundList(stubPaidSession(payment), []);

      await worker.drain();

      expect((await paymentOf(payment.id)).status).toBe('succeeded');
      expect(await timelineOf(payment.id)).toEqual([
        ['pending', 'succeeded', 'applied', 'reconciliation'],
      ]);
    });

    it('fails a complete but unpaid session whose intent needs a payment method', async () => {
      muteLogs();
      const payment = await insertDuePayment();
      stubSession(payment, {
        status: 'complete',
        payment_status: 'unpaid',
        payment_intent: paymentIntentFixture({
          status: 'requires_payment_method',
        }),
      });

      await worker.drain();

      expect((await paymentOf(payment.id)).status).toBe('failed');
    });

    it('expires an expired session', async () => {
      muteLogs();
      const payment = await insertDuePayment();
      stubSession(payment, { status: 'expired', payment_status: 'unpaid' });

      await worker.drain();

      const stored = await paymentOf(payment.id);
      expect(stored.status).toBe('expired');
      expect(stored.reconcileAfter).toBeNull();
    });

    it('changes nothing when Stripe does not know the session', async () => {
      const { warn } = muteLogs();
      const payment = await insertDuePayment();
      fetchHandlers.set(
        `GET ${STRIPE_API}/v1/checkout/sessions/${payment.providerPaymentId}`,
        () =>
          Promise.resolve(
            jsonResponse(
              errorBodyFixture('invalid_request_error', 'resource_missing'),
              404,
            ),
          ),
      );

      await worker.drain();

      expect((await paymentOf(payment.id)).status).toBe('pending');
      expect(await timelineOf(payment.id)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(payment.id));
    });

    it('skips Stripe for the rest of the cycle on a session status it does not know', async () => {
      muteLogs();
      const first = await insertDuePayment({ dueAgoSeconds: 30 });
      const second = await insertDuePayment({ dueAgoSeconds: 10 });
      stubSession(first, { status: 'processing', payment_status: 'unpaid' });
      stubSession(second, { status: 'open', payment_status: 'unpaid' });

      await worker.drain();

      expect(stubFetch).toHaveBeenCalledTimes(1);
      expect((await paymentOf(first.id)).status).toBe('pending');
      expect((await paymentOf(second.id)).reconcileAttempts).toBe(0);
    });
  });

  describe('refunds', () => {
    it(
      'records a refund made in the Dashboard once, with origin provider',
      async () => {
        muteLogs();
        const payment = await insertDuePayment({ status: 'succeeded' });
        const refundId = syntheticStripeId('re');
        stubRefundList(stubPaidSession(payment), [
          { id: refundId, amount: REFUND_AMOUNT_MINOR, status: 'succeeded' },
        ]);

        await worker.drain();

        expect(await refundRowsOf(payment.id)).toEqual([
          expect.objectContaining({
            provider: 'stripe',
            providerRefundId: refundId,
            origin: 'provider',
            status: 'succeeded',
            amountMinor: REFUND_AMOUNT_MINOR,
          }),
        ]);
        expect((await paymentOf(payment.id)).status).toBe('partially_refunded');
        const versions = await refundVersionsOf(payment.id);

        await makeDue(payment.id);
        await worker.drain();

        expect(await refundVersionsOf(payment.id)).toEqual(versions);
        expect(await timelineOf(payment.id)).toHaveLength(1);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it('keeps two refunds of the same amount apart by their ids', async () => {
      muteLogs();
      const payment = await insertDuePayment({ status: 'succeeded' });
      stubRefundList(stubPaidSession(payment), [
        { amount: REFUND_AMOUNT_MINOR, status: 'succeeded' },
        { amount: REFUND_AMOUNT_MINOR, status: 'succeeded' },
      ]);

      await worker.drain();

      expect(await refundRowsOf(payment.id)).toHaveLength(2);
    });

    it('records a canceled refund as failed', async () => {
      muteLogs();
      const payment = await insertDuePayment({ status: 'succeeded' });
      stubRefundList(stubPaidSession(payment), [
        { amount: REFUND_AMOUNT_MINOR, status: 'canceled' },
      ]);

      await worker.drain();

      expect(await refundRowsOf(payment.id)).toEqual([
        expect.objectContaining({ status: 'failed' }),
      ]);
      expect((await paymentOf(payment.id)).status).toBe('succeeded');
    });

    it('fails the check with no writes when the list has more pages', async () => {
      muteLogs();
      const payment = await insertDuePayment({
        status: 'succeeded',
        dueAgoSeconds: 30,
      });
      stubRefundList(
        stubPaidSession(payment),
        [{ amount: REFUND_AMOUNT_MINOR, status: 'succeeded' }],
        true,
      );
      const next = await insertDuePayment({
        status: 'succeeded',
        dueAgoSeconds: 10,
      });

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

    it('lists no refunds of a paid session without a payment intent, with no second call', async () => {
      muteLogs();
      const payment = await insertDuePayment({ status: 'succeeded' });
      stubSession(payment, {
        status: 'complete',
        payment_status: 'paid',
        payment_intent: null,
      });

      await worker.drain();

      expect(
        stubFetch.mock.calls.map(([url]) => new URL(url as string).pathname),
      ).toEqual([
        `/v1/checkout/sessions/${payment.providerPaymentId}`,
        `/v1/checkout/sessions/${payment.providerPaymentId}`,
      ]);
      expect(await refundRowsOf(payment.id)).toEqual([]);
    });
  });
});
