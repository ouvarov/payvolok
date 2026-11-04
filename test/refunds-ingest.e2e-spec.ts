import { randomUUID } from 'node:crypto';

import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { asc, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';

import { AppModule } from '@/app.module';
import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type NewPayment,
  type Payment,
  type PaymentEvent,
} from '@/database/schemas/payments.schema';
import { refunds, type Refund } from '@/database/schemas/refunds.schema';
import {
  IngestRejectedError,
  PaymentProviderRefOwnedError,
  PaymentsService,
} from '@/payments/payments.service';
import {
  RefundEventInvalidError,
  RefundMismatchError,
  RefundPaymentNotFoundError,
  RefundsService,
  type IngestRefundInput,
} from '@/refunds/refunds.service';

import { applyMigrations } from './apply-migrations';

const PGLITE_POOL_MAX = 1;
const REAL_POSTGRES_POOL_MAX = 5;
const POOL_WARMUP_SLEEP_SECONDS = 0.1;
const PARALLEL_REFUNDS = 20;
const PARALLEL_REFUND_AMOUNT_MINOR = 50;
const RACE_REPEATS = 3;
const CONNECT_TIMEOUT_SECONDS = 10;
const CLIENT_END_TIMEOUT_SECONDS = 5;
const LOCK_WAIT_POLL_MS = 100;
const LOCK_WAIT_DEADLINE_MS = 8000;
const SLOW_TEST_TIMEOUT_MS = 60000;

const databaseUrl = process.env.E2E_DATABASE_URL as string;
const isRealPostgres = process.env.E2E_REAL_POSTGRES === 'true';
const describeOnRealPostgres = isRealPostgres ? describe : describe.skip;
const databasePoolMax = isRealPostgres
  ? REAL_POSTGRES_POOL_MAX
  : PGLITE_POOL_MAX;

const refundInputFor = (
  payment: Pick<Payment, 'providerPaymentId'>,
  overrides: Partial<IngestRefundInput> = {},
): IngestRefundInput => ({
  reference: null,
  provider: 'fake',
  providerPaymentId: payment.providerPaymentId as string,
  refundReference: null,
  providerRefundId: randomUUID(),
  status: 'succeeded',
  amountMinor: 300,
  currency: 'USD',
  reason: 'e2e refund',
  webhookEventId: null,
  ...overrides,
});

const databaseCauseOf = async (
  query: () => PromiseLike<unknown>,
): Promise<{ code?: string }> => {
  const error = (await Promise.resolve(query()).then(
    () => ({}),
    (caught: unknown) => caught,
  )) as { cause?: { code?: string } };

  return error.cause ?? {};
};

describe('Refunds ingest', () => {
  let app: INestApplication;
  let db: Database;
  let paymentsService: PaymentsService;
  let refundsService: RefundsService;

  const insertPayment = async (
    overrides: Partial<NewPayment> = {},
  ): Promise<Payment> => {
    const [payment] = await db
      .insert(payments)
      .values({
        provider: 'fake',
        providerPaymentId: randomUUID(),
        purpose: 'one_off',
        origin: 'api',
        status: 'succeeded',
        amountMinor: 1000,
        currency: 'USD',
        ...overrides,
      })
      .returning();

    return payment;
  };

  const storedPaymentOf = async (paymentId: string): Promise<Payment> => {
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

  const eventTimelineOf = (paymentId: string): Promise<PaymentEvent[]> =>
    db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, paymentId))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));

  const insertRefundSql = (
    paymentId: string,
    overrides: Partial<Record<'status' | 'origin' | 'currency', string>> & {
      amountMinor?: number;
    } = {},
  ) =>
    db.execute(sql`
      insert into refunds
        (payment_id, provider, provider_refund_id, origin, status, amount_minor, currency)
      values (
        ${paymentId},
        'fake',
        ${randomUUID()},
        ${overrides.origin ?? 'provider'},
        ${overrides.status ?? 'succeeded'},
        ${overrides.amountMinor ?? 100},
        ${overrides.currency ?? 'USD'}
      )
    `);

  // On a cold pool the first transaction commits before other connections open,
  // so parallel work would run one after another and prove nothing.
  const warmPool = async (): Promise<void> => {
    await Promise.all(
      Array.from({ length: databasePoolMax }, () =>
        db.execute(sql`select pg_sleep(${POOL_WARMUP_SLEEP_SECONDS})`),
      ),
    );
  };

  beforeAll(async () => {
    await applyMigrations(databaseUrl);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: 'DATABASE_URL' | 'DATABASE_POOL_MAX') =>
          ({
            DATABASE_URL: databaseUrl,
            DATABASE_POOL_MAX: databasePoolMax,
          })[key],
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get<Database>(DRIZZLE);
    paymentsService = app.get(PaymentsService);
    refundsService = app.get(RefundsService);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('cumulative status', () => {
    it('goes partially_refunded then refunded with one row per refund', async () => {
      const payment = await insertPayment();

      const first = await refundsService.ingestRefund(
        refundInputFor(payment, { amountMinor: 300 }),
      );
      const second = await refundsService.ingestRefund(
        refundInputFor(payment, { amountMinor: 700 }),
      );

      expect(first.payment.status).toBe('partially_refunded');
      expect(first.refundedTotalMinor).toBe(300);
      expect(second.payment.status).toBe('refunded');
      expect(second.refundedTotalMinor).toBe(1000);
      expect((await storedPaymentOf(payment.id)).status).toBe('refunded');
      expect(await refundRowsOf(payment.id)).toHaveLength(2);
      const events = await eventTimelineOf(payment.id);
      expect(
        events.map(({ fromStatus, toStatus, outcome }) => [
          fromStatus,
          toStatus,
          outcome,
        ]),
      ).toEqual([
        ['succeeded', 'partially_refunded', 'applied'],
        ['partially_refunded', 'refunded', 'applied'],
      ]);
    });

    it('does not count failed refunds', async () => {
      const payment = await insertPayment();

      const failed = await refundsService.ingestRefund(
        refundInputFor(payment, { status: 'failed', amountMinor: 900 }),
      );
      expect(failed.paymentOutcome).toBe('unchanged');
      expect((await storedPaymentOf(payment.id)).status).toBe('succeeded');
      expect(await eventTimelineOf(payment.id)).toHaveLength(0);

      const succeeded = await refundsService.ingestRefund(
        refundInputFor(payment, { amountMinor: 200 }),
      );

      expect(succeeded.refundedTotalMinor).toBe(200);
      expect(succeeded.payment.status).toBe('partially_refunded');
      expect(await refundRowsOf(payment.id)).toHaveLength(2);
    });

    it('keeps an over-refund as a fact, ends refunded and warns', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const payment = await insertPayment();

      await refundsService.ingestRefund(
        refundInputFor(payment, { amountMinor: 1000 }),
      );
      expect(warn).not.toHaveBeenCalled();

      const { refundedTotalMinor, payment: finalPayment } =
        await refundsService.ingestRefund(
          refundInputFor(payment, { amountMinor: 300 }),
        );

      expect(refundedTotalMinor).toBe(1300);
      expect(finalPayment.status).toBe('refunded');
      expect(await refundRowsOf(payment.id)).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`Payment ${payment.id} over-refunded`),
      );
    });

    it('keeps the origin of the payment row', async () => {
      const payment = await insertPayment({ origin: 'api' });

      await refundsService.ingestRefund(refundInputFor(payment));

      expect((await storedPaymentOf(payment.id)).origin).toBe('api');
    });
  });

  describe('amount and currency', () => {
    it('never applies the payment amount check to a 300 refund', async () => {
      const payment = await insertPayment();

      const { refund, payment: finalPayment } =
        await refundsService.ingestRefund(
          refundInputFor(payment, { amountMinor: 300 }),
        );

      expect(refund.amountMinor).toBe(300);
      expect(finalPayment.amountMinor).toBe(1000);
    });

    it('rejects another currency and writes nothing, not even the link', async () => {
      const payment = await insertPayment({ providerPaymentId: null });

      await expect(
        refundsService.ingestRefund(
          refundInputFor(
            { providerPaymentId: randomUUID() },
            { reference: payment.id, currency: 'EUR' },
          ),
        ),
      ).rejects.toBeInstanceOf(RefundMismatchError);

      expect(await refundRowsOf(payment.id)).toHaveLength(0);
      expect(await eventTimelineOf(payment.id)).toHaveLength(0);
      expect(await storedPaymentOf(payment.id)).toEqual(payment);
    });

    it.each([
      ['a lowercase currency', { currency: 'usd' }],
      ['a zero amount', { amountMinor: 0 }],
      ['an unsafe amount', { amountMinor: 2 ** 53 }],
      ['no id', { providerRefundId: null }],
    ])('rejects %s and writes nothing', async (_case, overrides) => {
      const payment = await insertPayment();

      await expect(
        refundsService.ingestRefund(refundInputFor(payment, overrides)),
      ).rejects.toBeInstanceOf(RefundEventInvalidError);

      expect(await refundRowsOf(payment.id)).toHaveLength(0);
    });
  });

  describe('out of order', () => {
    it('ends succeeded for succeeded then pending and counts it once', async () => {
      const payment = await insertPayment();
      const input = refundInputFor(payment);

      await refundsService.ingestRefund(input);
      const late = await refundsService.ingestRefund({
        ...input,
        status: 'pending',
      });

      expect(late.refundOutcome).toBe('stale');
      expect(late.refund.status).toBe('succeeded');
      expect(late.refundedTotalMinor).toBe(300);
      const rows = await refundRowsOf(payment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('succeeded');
      expect((await storedPaymentOf(payment.id)).status).toBe(
        'partially_refunded',
      );
      expect(await eventTimelineOf(payment.id)).toHaveLength(1);
    });

    it('moves a pending refund to succeeded and only then touches the payment', async () => {
      const payment = await insertPayment();
      const input = refundInputFor(payment, { status: 'pending' });

      const pending = await refundsService.ingestRefund(input);
      expect(pending.paymentOutcome).toBe('unchanged');
      expect((await storedPaymentOf(payment.id)).status).toBe('succeeded');

      const succeeded = await refundsService.ingestRefund({
        ...input,
        status: 'succeeded',
      });

      expect(succeeded.refundOutcome).toBe('applied');
      expect(succeeded.refund.updatedAt.getTime()).toBeGreaterThan(
        pending.refund.updatedAt.getTime(),
      );
      expect(succeeded.payment.status).toBe('partially_refunded');
    });

    it.each([
      ['succeeded', 'failed'],
      ['failed', 'succeeded'],
    ] as const)(
      'keeps %s, and warns, when %s follows it',
      async (firstStatus, secondStatus) => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        const payment = await insertPayment();
        const input = refundInputFor(payment, { status: firstStatus });
        const { refund } = await refundsService.ingestRefund(input);

        const { refundOutcome, refund: finalRefund } =
          await refundsService.ingestRefund({
            ...input,
            status: secondStatus,
          });

        expect(refundOutcome).toBe('conflict');
        expect(finalRefund.status).toBe(firstStatus);
        expect((await refundRowsOf(payment.id))[0].status).toBe(firstStatus);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`Refund ${refund.id} conflict`),
        );
      },
    );

    it('throws a retryable not-found before the payment exists, then applies', async () => {
      const providerPaymentId = randomUUID();
      const input = refundInputFor({ providerPaymentId });

      const error: unknown = await refundsService
        .ingestRefund(input)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RefundPaymentNotFoundError);
      expect(error).not.toBeInstanceOf(IngestRejectedError);
      expect(
        await db
          .select()
          .from(payments)
          .where(eq(payments.providerPaymentId, providerPaymentId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(refunds)
          .where(
            eq(refunds.providerRefundId, input.providerRefundId as string),
          ),
      ).toHaveLength(0);

      const payment = await insertPayment({ providerPaymentId });
      const retried = await refundsService.ingestRefund(input);

      expect(retried.refundOutcome).toBe('created');
      expect(retried.payment.id).toBe(payment.id);
      expect(retried.payment.status).toBe('partially_refunded');
    });

    it.each(['created', 'pending'] as const)(
      'applies a refund on %s and a late succeeded is stale',
      async (status) => {
        const payment = await insertPayment({ status });

        const { payment: refundedPayment } = await refundsService.ingestRefund(
          refundInputFor(payment, { amountMinor: 1000 }),
        );
        expect(refundedPayment.status).toBe('refunded');

        const { outcome, payment: finalPayment } =
          await paymentsService.ingestPayment({
            reference: null,
            provider: 'fake',
            providerPaymentId: payment.providerPaymentId as string,
            status: 'succeeded',
            amountMinor: 1000,
            currency: 'USD',
            purpose: 'one_off',
            origin: 'provider',
            reason: 'late',
            webhookEventId: null,
          });

        expect(outcome).toBe('stale');
        expect(finalPayment.status).toBe('refunded');
      },
    );

    it.each(['failed', 'expired'] as const)(
      'keeps %s, stores the refund, writes a conflict and warns',
      async (status) => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        const payment = await insertPayment({ status });

        const { refund, paymentOutcome } = await refundsService.ingestRefund(
          refundInputFor(payment),
        );

        expect(paymentOutcome).toBe('conflict');
        expect((await storedPaymentOf(payment.id)).status).toBe(status);
        expect((await refundRowsOf(payment.id)).map(({ id }) => id)).toEqual([
          refund.id,
        ]);
        const events = await eventTimelineOf(payment.id);
        expect(
          events.map(({ fromStatus, toStatus, outcome }) => [
            fromStatus,
            toStatus,
            outcome,
          ]),
        ).toEqual([[status, 'partially_refunded', 'conflict']]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`Payment ${payment.id} conflict`),
        );
      },
    );
  });

  describe('identity', () => {
    it('births a provider-initiated refund once and a repeat changes nothing', async () => {
      const payment = await insertPayment();
      const input = refundInputFor(payment);

      const first = await refundsService.ingestRefund(input);
      const paymentAfterFirst = await storedPaymentOf(payment.id);
      const eventsAfterFirst = await eventTimelineOf(payment.id);
      const repeat = await refundsService.ingestRefund(input);

      expect(first.refundOutcome).toBe('created');
      expect(first.refund.origin).toBe('provider');
      expect(repeat.refundOutcome).toBe('duplicate');
      expect(repeat.paymentOutcome).toBe('duplicate');
      expect(repeat.refundedTotalMinor).toBe(300);
      expect(await refundRowsOf(payment.id)).toEqual([first.refund]);
      expect(await storedPaymentOf(payment.id)).toEqual(paymentAfterFirst);
      expect(await eventTimelineOf(payment.id)).toEqual(eventsAfterFirst);
    });

    it('keeps a reference-only refund idempotent through the row id', async () => {
      const payment = await insertPayment();
      const refundReference = randomUUID();
      const input = refundInputFor(payment, {
        refundReference,
        providerRefundId: null,
      });

      const first = await refundsService.ingestRefund(input);
      const repeat = await refundsService.ingestRefund(input);

      expect(first.refund.id).toBe(refundReference);
      expect(repeat.refundOutcome).toBe('duplicate');
      expect(repeat.refundedTotalMinor).toBe(300);
      expect(await refundRowsOf(payment.id)).toHaveLength(1);
    });

    it('finds a row by its reference and links a null provider id', async () => {
      const payment = await insertPayment();
      const refundReference = randomUUID();
      const providerRefundId = randomUUID();
      const input = refundInputFor(payment, {
        refundReference,
        providerRefundId: null,
        status: 'pending',
      });
      await refundsService.ingestRefund(input);

      const linked = await refundsService.ingestRefund({
        ...input,
        providerRefundId,
        status: 'succeeded',
      });

      expect(linked.refundOutcome).toBe('applied');
      expect(linked.refund).toMatchObject({
        id: refundReference,
        providerRefundId,
        status: 'succeeded',
      });
      expect(await refundRowsOf(payment.id)).toHaveLength(1);
    });

    it('finds the payment by reference and links its null provider id', async () => {
      const payment = await insertPayment({ providerPaymentId: null });
      const providerPaymentId = randomUUID();

      const { payment: linkedPayment } = await refundsService.ingestRefund(
        refundInputFor({ providerPaymentId }, { reference: payment.id }),
      );

      expect(linkedPayment).toMatchObject({
        id: payment.id,
        providerPaymentId,
        status: 'partially_refunded',
      });
    });

    it('throws the owned error when another payment owns the provider payment id', async () => {
      const owner = await insertPayment();
      const row = await insertPayment({ providerPaymentId: null });

      await expect(
        refundsService.ingestRefund(
          refundInputFor(owner, { reference: row.id }),
        ),
      ).rejects.toBeInstanceOf(PaymentProviderRefOwnedError);

      expect(await storedPaymentOf(row.id)).toEqual(row);
      expect(await storedPaymentOf(owner.id)).toEqual(owner);
      expect(await refundRowsOf(row.id)).toHaveLength(0);
      expect(await refundRowsOf(owner.id)).toHaveLength(0);
    });

    it('rejects the same id with a different amount and rolls back', async () => {
      const payment = await insertPayment();
      const input = refundInputFor(payment, { status: 'pending' });
      const { refund } = await refundsService.ingestRefund(input);

      await expect(
        refundsService.ingestRefund({
          ...input,
          status: 'succeeded',
          amountMinor: 400,
        }),
      ).rejects.toBeInstanceOf(RefundMismatchError);

      expect(await refundRowsOf(payment.id)).toEqual([refund]);
      expect(await storedPaymentOf(payment.id)).toEqual(payment);
      expect(await eventTimelineOf(payment.id)).toHaveLength(0);
    });

    it('rejects a provider refund id owned by another payment', async () => {
      const payment = await insertPayment();
      const otherPayment = await insertPayment();
      const input = refundInputFor(otherPayment);
      await refundsService.ingestRefund(input);

      await expect(
        refundsService.ingestRefund({
          ...refundInputFor(payment),
          providerRefundId: input.providerRefundId,
        }),
      ).rejects.toBeInstanceOf(RefundMismatchError);

      expect(await refundRowsOf(payment.id)).toHaveLength(0);
      expect(await storedPaymentOf(payment.id)).toEqual(payment);
    });

    it('rejects a reference owned by another payment through the insert conflict', async () => {
      const payment = await insertPayment();
      const otherPayment = await insertPayment();
      const refundReference = randomUUID();
      await refundsService.ingestRefund(
        refundInputFor(otherPayment, { refundReference }),
      );

      await expect(
        refundsService.ingestRefund(
          refundInputFor(payment, { refundReference }),
        ),
      ).rejects.toBeInstanceOf(RefundMismatchError);

      expect(await refundRowsOf(payment.id)).toHaveLength(0);
      expect(await storedPaymentOf(payment.id)).toEqual(payment);
    });

    it('rejects linking a provider refund id owned by another refund, on every attempt', async () => {
      const payment = await insertPayment();
      const otherPayment = await insertPayment();
      const owned = refundInputFor(otherPayment);
      await refundsService.ingestRefund(owned);
      const refundReference = randomUUID();
      const input = refundInputFor(payment, {
        refundReference,
        providerRefundId: null,
        status: 'pending',
      });
      const { refund } = await refundsService.ingestRefund(input);
      const linkingInput = {
        ...input,
        providerRefundId: owned.providerRefundId,
      };

      await expect(
        refundsService.ingestRefund(linkingInput),
      ).rejects.toBeInstanceOf(RefundMismatchError);
      await expect(
        refundsService.ingestRefund(linkingInput),
      ).rejects.toBeInstanceOf(RefundMismatchError);

      expect(await refundRowsOf(payment.id)).toEqual([refund]);
    });

    it('rejects a different provider id on a row found by reference', async () => {
      const payment = await insertPayment();
      const refundReference = randomUUID();
      const input = refundInputFor(payment, {
        refundReference,
        status: 'pending',
      });
      const { refund } = await refundsService.ingestRefund(input);

      await expect(
        refundsService.ingestRefund({
          ...input,
          providerRefundId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(RefundMismatchError);

      expect(await refundRowsOf(payment.id)).toEqual([refund]);
    });

    it('rejects a different reference on a row found by provider id', async () => {
      const payment = await insertPayment();
      const input = refundInputFor(payment);
      const { refund } = await refundsService.ingestRefund(input);

      await expect(
        refundsService.ingestRefund({
          ...input,
          refundReference: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(RefundMismatchError);

      expect(await refundRowsOf(payment.id)).toEqual([refund]);
    });
  });

  describe('database constraints', () => {
    it.each([
      ['status', { status: 'bogus' }],
      ['origin', { origin: 'bogus' }],
      ['zero amount_minor', { amountMinor: 0 }],
      ['lowercase currency', { currency: 'usd' }],
    ])('rejects a bad %s', async (_field, badValue) => {
      const payment = await insertPayment();

      const cause = await databaseCauseOf(() =>
        insertRefundSql(payment.id, badValue),
      );

      expect(cause.code).toBe('23514');
    });

    it('accepts the valid row those rejections are measured against', async () => {
      const payment = await insertPayment();

      await expect(insertRefundSql(payment.id)).resolves.toBeDefined();
    });

    it('rejects a refund of an unknown payment', async () => {
      const cause = await databaseCauseOf(() => insertRefundSql(randomUUID()));

      expect(cause.code).toBe('23503');
    });

    it('rejects deleting a payment that has refunds', async () => {
      const payment = await insertPayment();
      await refundsService.ingestRefund(refundInputFor(payment));

      const cause = await databaseCauseOf(() =>
        db.delete(payments).where(eq(payments.id, payment.id)),
      );

      expect(cause.code).toBe('23503');
    });
  });

  describe('application wiring', () => {
    it('boots with RefundsModule and maps no new route', () => {
      const httpInstance = app.getHttpAdapter().getInstance() as {
        router: { stack: { route?: { path: string } }[] };
      };

      const routePaths = httpInstance.router.stack
        .flatMap(({ route }) => (route ? [route.path] : []))
        .sort();

      expect(refundsService).toBeInstanceOf(RefundsService);
      expect(routePaths).toEqual(['/health/live', '/health/ready']);
    });
  });

  describeOnRealPostgres('real Postgres concurrency', () => {
    let holdingClient: postgres.Sql;

    const waitUntilBlockedBy = async (blockerPid: number): Promise<boolean> => {
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

    const backendPidOf = async (
      connection: postgres.ReservedSql,
    ): Promise<number> => {
      const [{ pid }] = await connection<{ pid: number }[]>`
        select pg_backend_pid() as pid
      `;

      return pid;
    };

    const trackSettled = <T>(work: Promise<T>) => {
      const tracker = { isSettled: false, work };
      const markSettled = () => {
        tracker.isSettled = true;
      };
      work.then(markSettled, markSettled);

      return tracker;
    };

    beforeAll(() => {
      holdingClient = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        connect_timeout: CONNECT_TIMEOUT_SECONDS,
        onnotice: () => {},
      });
    });

    afterAll(async () => {
      await holdingClient.end({ timeout: CLIENT_END_TIMEOUT_SECONDS });
    });

    it(
      'keeps the sum and the final status right for 20 parallel refund events',
      async () => {
        await warmPool();

        for (let repeat = 0; repeat < RACE_REPEATS; repeat += 1) {
          const payment = await insertPayment();

          const results = await Promise.all(
            Array.from({ length: PARALLEL_REFUNDS }, () =>
              refundsService.ingestRefund(
                refundInputFor(payment, {
                  amountMinor: PARALLEL_REFUND_AMOUNT_MINOR,
                }),
              ),
            ),
          );

          const rows = await refundRowsOf(payment.id);
          const storedPayment = await storedPaymentOf(payment.id);
          const events = await eventTimelineOf(payment.id);

          expect(rows).toHaveLength(PARALLEL_REFUNDS);
          expect(
            rows.reduce((total, { amountMinor }) => total + amountMinor, 0),
          ).toBe(payment.amountMinor);
          expect(storedPayment.status).toBe('refunded');
          expect(
            results
              .map(({ refundedTotalMinor }) => refundedTotalMinor)
              .sort((left, right) => left - right),
          ).toEqual(
            Array.from(
              { length: PARALLEL_REFUNDS },
              (_unused, index) => (index + 1) * PARALLEL_REFUND_AMOUNT_MINOR,
            ),
          );
          expect(
            events.map(({ fromStatus, toStatus }) => [fromStatus, toStatus]),
          ).toEqual([
            ['succeeded', 'partially_refunded'],
            ['partially_refunded', 'refunded'],
          ]);
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'counts parallel deliveries of one refund once',
      async () => {
        await warmPool();
        const payment = await insertPayment();
        const input = refundInputFor(payment);

        const results = await Promise.all(
          Array.from({ length: PARALLEL_REFUNDS }, () =>
            refundsService.ingestRefund(input),
          ),
        );

        expect(
          results.map(({ refundOutcome }) => refundOutcome).sort(),
        ).toEqual([
          'created',
          ...Array.from({ length: PARALLEL_REFUNDS - 1 }, () => 'duplicate'),
        ]);
        expect(await refundRowsOf(payment.id)).toHaveLength(1);
        expect(await eventTimelineOf(payment.id)).toHaveLength(1);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it.each([
      ['the provider ref', false],
      ['the reference', true],
    ])(
      'waits on the payment row lock when found by %s',
      async (_case, isByReference) => {
        const payment = await insertPayment();
        const input = refundInputFor(payment, {
          reference: isByReference ? payment.id : null,
          status: 'pending',
        });
        const connection = await holdingClient.reserve();

        try {
          await connection.unsafe('begin');
          // NO KEY UPDATE lets the refund insert's foreign key check through and a
          // pending refund never updates the payment, so only the lookup lock can wait.
          await connection`
            select id from payments where id = ${payment.id} for no key update
          `;
          const pid = await backendPidOf(connection);
          const ingest = trackSettled(refundsService.ingestRefund(input));

          expect(await waitUntilBlockedBy(pid)).toBe(true);
          expect(ingest.isSettled).toBe(false);

          await connection.unsafe('commit');
          const { refundOutcome } = await ingest.work;

          expect(refundOutcome).toBe('created');
        } finally {
          await connection.unsafe('rollback');
          connection.release();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'turns an insert race on a provider refund id into a mismatch',
      async () => {
        const payment = await insertPayment();
        const otherPayment = await insertPayment();
        const input = refundInputFor(payment);
        const connection = await holdingClient.reserve();

        try {
          await connection.unsafe('begin');
          await connection`
            insert into refunds
              (payment_id, provider, provider_refund_id, origin, status, amount_minor, currency)
            values (
              ${otherPayment.id},
              'fake',
              ${input.providerRefundId},
              'provider',
              'succeeded',
              ${input.amountMinor},
              'USD'
            )
          `;
          const pid = await backendPidOf(connection);
          const ingest = trackSettled(
            refundsService
              .ingestRefund(input)
              .catch((caught: unknown) => caught),
          );

          expect(await waitUntilBlockedBy(pid)).toBe(true);
          expect(ingest.isSettled).toBe(false);

          await connection.unsafe('commit');

          expect(await ingest.work).toBeInstanceOf(RefundMismatchError);
          expect(await refundRowsOf(payment.id)).toHaveLength(0);
          expect(await storedPaymentOf(payment.id)).toEqual(payment);
        } finally {
          await connection.unsafe('rollback');
          connection.release();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });
});
