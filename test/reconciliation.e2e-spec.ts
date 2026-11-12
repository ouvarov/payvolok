import { randomInt, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { Logger, type INestApplication } from '@nestjs/common';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
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
import { refunds } from '@/database/schemas/refunds.schema';
import {
  IDEMPOTENCY_KEY_TTL_SECONDS,
  IDEMPOTENCY_LEASE_SECONDS,
} from '@/idempotency/idempotency.constants';
import { RECONCILE_GRACE_SECONDS } from '@/payments/payment.constants';
import { PaymentsService } from '@/payments/payments.service';
import { encodeFakeId } from '@/providers/fake/fake-wire-format';
import { FakeProvider } from '@/providers/fake/fake.provider';
import { PaddleProvider } from '@/providers/paddle/paddle.provider';
import {
  ProviderError,
  type ResourceStatus,
  type StatusQuery,
} from '@/providers/payment-provider.port';
import {
  PENDING_RECONCILE_DELAYS_SECONDS,
  RECONCILE_BATCH_SIZE,
  REFUNDABLE_RECONCILE_DELAY_SECONDS,
} from '@/reconciliation/reconciliation.constants';
import { ReconciliationRepository } from '@/reconciliation/reconciliation.repository';
import { ReconciliationWorker } from '@/reconciliation/reconciliation.worker';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import {
  createE2eApp,
  databaseUrl,
  describeOnRealPostgres,
  serverOf,
  TEST_API_KEY,
} from './helpers';

const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const RETURN_URL = 'https://shop.example.test/return';
const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const POLL_INTERVAL_MS = 50;
const WAIT_DEADLINE_MS = 10000;
const LOCK_FREE_CLAIM_DEADLINE_MS = 3000;
const SLOW_TEST_TIMEOUT_MS = 60000;
const MIGRATIONS_BEFORE_0008 = 8;
const PADDLE_TRANSACTION_ID_LENGTH = 26;

type DuePaymentInput = Partial<
  Pick<NewPayment, 'provider' | 'providerPaymentId' | 'status' | 'amountMinor'>
> & {
  createdAgoSeconds?: number;
  dueAgoSeconds?: number;
  attempts?: number;
};

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

const fakePaymentIdOf = (amountMinor: number): string =>
  encodeFakeId({ reference: randomUUID(), amountMinor, currency: 'USD' });

const paddleTransactionId = (): string =>
  `txn_${Array.from({ length: PADDLE_TRANSACTION_ID_LENGTH }, () =>
    randomInt(36).toString(36),
  ).join('')}`;

const uniqueAmountMinor = (suffix = 0): number =>
  randomInt(10_000, 10_000_000) * 100 + suffix;

const paymentBodyWith = () => ({
  provider: 'fake',
  amountMinor: uniqueAmountMinor(),
  currency: 'USD',
  description: 'e2e order',
  returnUrl: RETURN_URL,
});

const newKey = (): string => `e2e-${randomUUID()}`;

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

const testPaymentIds = new Set<string>();

// The e2e database is shared with other spec files and earlier runs, whose
// payments fall due too; a drain here must see only this test's payments.
class TestScopedReconciliationRepository extends ReconciliationRepository {
  protected claimableRows(): SQL {
    if (testPaymentIds.size === 0) return sql`false`;

    return sql`id IN (${sql.join(
      [...testPaymentIds].map((paymentId) => sql`${paymentId}::uuid`),
      sql`, `,
    )})`;
  }
}

const TEST_SCOPED_RECONCILIATION = {
  provide: ReconciliationRepository,
  useClass: TestScopedReconciliationRepository,
};

describe('Reconciliation', () => {
  let app: INestApplication;
  let db: Database;
  let worker: ReconciliationWorker;
  let fakeProvider: FakeProvider;

  const insertDuePayment = async ({
    provider = 'fake',
    status = 'pending',
    amountMinor = 1000,
    providerPaymentId = provider === 'fake'
      ? fakePaymentIdOf(amountMinor)
      : paddleTransactionId(),
    createdAgoSeconds = HOUR_SECONDS,
    dueAgoSeconds = 1,
    attempts = 0,
  }: DuePaymentInput = {}): Promise<Payment> => {
    const [payment] = await db
      .insert(payments)
      .values({
        provider,
        providerPaymentId,
        purpose: 'one_off',
        origin: 'api',
        status,
        amountMinor,
        currency: 'USD',
        createdAt: sql`clock_timestamp() - ${createdAgoSeconds}::double precision * interval '1 second'`,
        reconcileAfter: sql`clock_timestamp() - ${dueAgoSeconds}::double precision * interval '1 second'`,
        reconcileAttempts: attempts,
      })
      .returning();
    testPaymentIds.add(payment.id);

    return payment;
  };

  const paymentOf = async (paymentId: string): Promise<Payment> => {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment;
  };

  const eventsOf = (paymentId: string) =>
    db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, paymentId))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));

  const timelineOf = async (paymentId: string) =>
    (await eventsOf(paymentId)).map(
      ({ fromStatus, toStatus, outcome, reason }) => [
        fromStatus,
        toStatus,
        outcome,
        reason,
      ],
    );

  const keyRowOf = async (key: string): Promise<IdempotencyKey | null> => {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, 'api:create_payment'),
          eq(idempotencyKeys.key, key),
        ),
      );

    return row ?? null;
  };

  const ageKey = async (key: string, seconds: number): Promise<void> => {
    await db.execute(sql`
      update idempotency_keys
      set created_at = created_at - ${seconds}::integer * interval '1 second'
      where scope = 'api:create_payment' and key = ${key}
    `);
  };

  const makeDue = async (paymentId: string): Promise<void> => {
    await db.execute(sql`
      update payments
      set reconcile_after = clock_timestamp() - interval '1 second'
      where id = ${paymentId}
    `);
  };

  const postPayment = (body: object, idempotencyKey: string) =>
    request(serverOf(app))
      .post(PAYMENTS_PATH)
      .set('Authorization', `Bearer ${TEST_API_KEY}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

  const getPayment = (paymentId: string) =>
    request(serverOf(app))
      .get(`${PAYMENTS_PATH}/${paymentId}`)
      .set('Authorization', `Bearer ${TEST_API_KEY}`);

  const interruptedRequest = async () => {
    const key = newKey();
    const body = paymentBodyWith();
    jest
      .spyOn(PaymentsService.prototype, 'recordCreated')
      .mockRejectedValueOnce(new Error('crash after the provider answered'));
    await postPayment(body, key).expect(500);
    const paymentId = (await keyRowOf(key))?.paymentId as string;

    testPaymentIds.add(paymentId);

    return { key, body, paymentId };
  };

  const paymentStatusFor = (
    payment: Payment,
    status: Extract<ResourceStatus, { resource: 'payment' }>['status'],
  ): ResourceStatus => ({
    resource: 'payment',
    providerPaymentId: payment.providerPaymentId as string,
    status,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
  });

  beforeAll(async () => {
    app = await createE2eApp({ classOverrides: [TEST_SCOPED_RECONCILIATION] });
    db = app.get<Database>(DRIZZLE);
    worker = app.get(ReconciliationWorker);
    fakeProvider = app.get(FakeProvider);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    testPaymentIds.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a payment with a provider id', () => {
    it('applies a status the provider settled once, without a webhook, then checks daily', async () => {
      muteLogs();
      const payment = await insertDuePayment({ amountMinor: 1000 });

      await worker.drain();

      const stored = await paymentOf(payment.id);
      expect(stored.status).toBe('succeeded');
      expect(await eventsOf(payment.id)).toEqual([
        expect.objectContaining({
          fromStatus: 'pending',
          toStatus: 'succeeded',
          outcome: 'applied',
          reason: 'reconciliation',
          webhookEventId: null,
        }),
      ]);
      expect(secondsScheduledAfterCheck(stored)).toBe(
        REFUNDABLE_RECONCILE_DELAY_SECONDS,
      );
    });

    it('backs a payment the provider still has pending off by its age, writing no event', async () => {
      const payment = await insertDuePayment({
        amountMinor: 1005,
        createdAgoSeconds: 3 * HOUR_SECONDS,
        attempts: 3,
      });

      await worker.drain();

      const stored = await paymentOf(payment.id);
      expect(stored.status).toBe('pending');
      expect(stored.reconcileAttempts).toBe(4);
      expect(secondsScheduledAfterCheck(stored)).toBe(
        PENDING_RECONCILE_DELAYS_SECONDS[4],
      );
      expect(await eventsOf(payment.id)).toEqual([]);
    });

    it('expires a payment the provider reports expired and never claims it again', async () => {
      muteLogs();
      const payment = await insertDuePayment({ amountMinor: 1004 });

      await worker.drain();

      const expired = await paymentOf(payment.id);
      expect(expired.status).toBe('expired');
      expect(expired.reconcileAfter).toBeNull();
      expect(await timelineOf(payment.id)).toEqual([
        ['pending', 'expired', 'applied', 'reconciliation'],
      ]);

      await makeDue(payment.id);
      await worker.drain();

      expect((await paymentOf(payment.id)).reconcileAttempts).toBe(1);
    });

    it.each(['refunded', 'partially_refunded'] as const)(
      'records a %s answer as succeeded and invents no refund',
      async (providerStatus) => {
        muteLogs();
        const payment = await insertDuePayment();
        jest
          .spyOn(fakeProvider, 'getStatus')
          .mockResolvedValue(paymentStatusFor(payment, providerStatus));

        await worker.drain();

        expect((await paymentOf(payment.id)).status).toBe('succeeded');
        expect(await timelineOf(payment.id)).toEqual([
          ['pending', 'succeeded', 'applied', 'reconciliation'],
        ]);
        expect(
          await db
            .select()
            .from(refunds)
            .where(eq(refunds.paymentId, payment.id)),
        ).toEqual([]);
      },
    );

    it('warns and backs off when the provider does not know the payment', async () => {
      const { warn } = muteLogs();
      const payment = await insertDuePayment();
      jest.spyOn(fakeProvider, 'getStatus').mockResolvedValue(null);

      await worker.drain();

      const stored = await paymentOf(payment.id);
      expect(stored.status).toBe('pending');
      expect(secondsScheduledAfterCheck(stored)).toBe(
        PENDING_RECONCILE_DELAYS_SECONDS[3],
      );
      expect(await eventsOf(payment.id)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(payment.id));
    });

    it('logs a payment that does not match the provider and reconciles the others', async () => {
      const { error } = muteLogs();
      const first = await insertDuePayment({ dueAgoSeconds: 30 });
      const mismatched = await insertDuePayment({
        providerPaymentId: fakePaymentIdOf(2000),
        dueAgoSeconds: 20,
      });
      const last = await insertDuePayment({ dueAgoSeconds: 10 });

      await expect(worker.drain()).resolves.toBe(3);

      expect((await paymentOf(first.id)).status).toBe('succeeded');
      expect((await paymentOf(last.id)).status).toBe('succeeded');
      const stored = await paymentOf(mismatched.id);
      expect(stored.status).toBe('pending');
      expect(secondsScheduledAfterCheck(stored)).toBe(
        PENDING_RECONCILE_DELAYS_SECONDS[3],
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(mismatched.id),
      );
    });

    it('skips an unavailable provider for the rest of the cycle and checks the others', async () => {
      muteLogs();
      const paddleStatus = jest
        .spyOn(app.get(PaddleProvider), 'getStatus')
        .mockRejectedValue(
          new ProviderError('paddle is down', {
            providerCode: 'paddle',
            kind: 'unavailable',
          }),
        );
      await insertDuePayment({ provider: 'paddle', dueAgoSeconds: 30 });
      const secondPaddle = await insertDuePayment({
        provider: 'paddle',
        dueAgoSeconds: 20,
      });
      const fake = await insertDuePayment({ dueAgoSeconds: 10 });

      await worker.drain();

      expect(paddleStatus).toHaveBeenCalledTimes(1);
      expect((await paymentOf(fake.id)).status).toBe('succeeded');
      expect((await paymentOf(secondPaddle.id)).reconcileAttempts).toBe(0);

      await worker.drain();

      expect(paddleStatus).toHaveBeenCalledTimes(2);
    });

    it('checks at most one batch per drain', async () => {
      muteLogs();
      const due = await Promise.all(
        Array.from({ length: RECONCILE_BATCH_SIZE + 5 }, () =>
          insertDuePayment(),
        ),
      );

      await expect(worker.drain()).resolves.toBe(RECONCILE_BATCH_SIZE);

      const checked = await Promise.all(due.map(({ id }) => paymentOf(id)));
      expect(
        checked.filter(({ reconcileAttempts }) => reconcileAttempts === 1),
      ).toHaveLength(RECONCILE_BATCH_SIZE);
      await expect(worker.drain()).resolves.toBe(5);
    });

    it('stops with a warning a payment still pending at the provider after 30 days', async () => {
      const { warn } = muteLogs();
      const payment = await insertDuePayment({
        amountMinor: 1005,
        createdAgoSeconds: 29.9 * DAY_SECONDS,
      });

      await worker.drain();

      expect((await paymentOf(payment.id)).reconcileAfter).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        `Payment ${payment.id} still pending at fake after 30 days; reconciliation stopped`,
      );
    });

    it('never claims a failed, expired or refunded payment', async () => {
      const getStatus = jest.spyOn(fakeProvider, 'getStatus');
      const settled = await Promise.all(
        (['failed', 'expired', 'refunded'] as const).map((status) =>
          insertDuePayment({ status }),
        ),
      );

      await expect(worker.drain()).resolves.toBe(0);

      expect(getStatus).not.toHaveBeenCalled();
      for (const { id } of settled) {
        expect((await paymentOf(id)).reconcileAttempts).toBe(0);
      }
    });
  });

  describe('a claimed check', () => {
    it('changes nothing when it finishes after its lease was taken over', async () => {
      const repository = app.get(ReconciliationRepository);
      const payment = await insertDuePayment();
      const claimed = await repository.claimNext([]);
      expect(claimed?.id).toBe(payment.id);
      if (!claimed) return;

      await expect(
        repository.finish(
          { ...claimed, reconcileAttempts: claimed.reconcileAttempts - 1 },
          null,
        ),
      ).resolves.toBe(false);
      expect((await paymentOf(payment.id)).reconcileAfter).not.toBeNull();

      await expect(repository.finish(claimed, null)).resolves.toBe(true);
      expect((await paymentOf(payment.id)).reconcileAfter).toBeNull();
    });

    it(
      'asks the provider without holding a connection',
      async () => {
        muteLogs();
        const singleConnectionApp = await createE2eApp({
          classOverrides: [TEST_SCOPED_RECONCILIATION],
          appDatabasePoolMax: 1,
        });

        try {
          const singleConnectionDb = singleConnectionApp.get<Database>(DRIZZLE);
          const singleConnectionFake = singleConnectionApp.get(FakeProvider);
          jest
            .spyOn(singleConnectionFake, 'getStatus')
            .mockImplementation(async (query: StatusQuery) => {
              await singleConnectionDb.execute(sql`select 1`);

              return FakeProvider.prototype.getStatus.call(
                singleConnectionFake,
                query,
              );
            });
          const payment = await insertDuePayment();

          const drain = singleConnectionApp.get(ReconciliationWorker).drain();

          expect(await isSettledWithin(drain, WAIT_DEADLINE_MS)).toBe(true);
          expect((await paymentOf(payment.id)).status).toBe('succeeded');
        } finally {
          await singleConnectionApp.close();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('a created payment without a provider id', () => {
    it('closes it as failed, completes its expired key with a 503 a retry replays, and calls no provider', async () => {
      muteLogs();
      const createPayment = jest.spyOn(fakeProvider, 'createPayment');
      const getStatus = jest.spyOn(fakeProvider, 'getStatus');
      const { key, body, paymentId } = await interruptedRequest();
      await ageKey(key, IDEMPOTENCY_LEASE_SECONDS + 1);
      await makeDue(paymentId);

      await worker.drain();

      expect((await paymentOf(paymentId)).status).toBe('failed');
      expect(await timelineOf(paymentId)).toEqual([
        [null, 'created', 'applied', 'api_request'],
        ['created', 'failed', 'applied', 'reconciliation_interrupted'],
      ]);
      const expectedBody = {
        statusCode: 503,
        code: 'provider_unavailable',
        message: expect.any(String) as string,
        paymentId,
      };
      expect(await keyRowOf(key)).toMatchObject({
        status: 'completed',
        responseStatus: 503,
        responseBody: expectedBody,
      });

      const retry = await postPayment(body, key).expect(503);

      expect(retry.body).toEqual(expectedBody);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(createPayment).toHaveBeenCalledTimes(1);
      expect(getStatus).not.toHaveBeenCalled();
    });

    it('closes it as failed when it has no key', async () => {
      muteLogs();
      const payment = await insertDuePayment({
        status: 'created',
        providerPaymentId: null,
      });

      await worker.drain();

      expect((await paymentOf(payment.id)).status).toBe('failed');
      expect(await timelineOf(payment.id)).toEqual([
        ['created', 'failed', 'applied', 'reconciliation_interrupted'],
      ]);
    });

    it('leaves a fresh one and one whose request still holds the key', async () => {
      muteLogs();
      const fresh = await interruptedRequest();
      const leased = await interruptedRequest();
      await makeDue(leased.paymentId);

      await expect(worker.drain()).resolves.toBe(1);

      const freshPayment = await paymentOf(fresh.paymentId);
      expect(freshPayment).toMatchObject({
        status: 'created',
        reconcileAttempts: 0,
      });
      expect(
        ((freshPayment.reconcileAfter?.getTime() ?? 0) -
          freshPayment.createdAt.getTime()) /
          1000,
      ).toBeCloseTo(RECONCILE_GRACE_SECONDS, 0);
      const leasedPayment = await paymentOf(leased.paymentId);
      expect(leasedPayment).toMatchObject({
        status: 'created',
        reconcileAttempts: 1,
      });
      expect(secondsScheduledAfterCheck(leasedPayment)).toBe(
        PENDING_RECONCILE_DELAYS_SECONDS[0],
      );
      expect(await keyRowOf(leased.key)).toMatchObject({
        status: 'in_progress',
      });
    });
  });

  describe('GET /payments/:id', () => {
    const PUBLIC_KEYS = [
      'amountMinor',
      'createdAt',
      'currency',
      'paymentId',
      'provider',
      'status',
      'updatedAt',
    ];

    const isDueNow = async (paymentId: string): Promise<boolean> => {
      const [{ is_due: isDue }] = await db.execute<{ is_due: boolean }>(sql`
        select reconcile_after <= clock_timestamp() as is_due
        from payments where id = ${paymentId}
      `);

      return isDue;
    };

    it('brings the next check of a pending payment forward without calling a provider', async () => {
      const getStatus = jest.spyOn(fakeProvider, 'getStatus');
      const payment = await insertDuePayment({
        createdAgoSeconds: 60,
        dueAgoSeconds: -600,
      });

      const response = await getPayment(payment.id).expect(200);

      expect(Object.keys(response.body as object).sort()).toEqual(PUBLIC_KEYS);
      expect(await isDueNow(payment.id)).toBe(true);
      expect((await paymentOf(payment.id)).updatedAt).toEqual(
        payment.updatedAt,
      );
      expect(getStatus).not.toHaveBeenCalled();
    });

    it('keeps the backoff of its age after several checks a GET brought forward', async () => {
      const payment = await insertDuePayment({
        amountMinor: 1005,
        createdAgoSeconds: 20 * 60,
        dueAgoSeconds: -600,
      });

      for (let check = 0; check < 4; check += 1) {
        await db.execute(sql`
          update payments set reconciled_at = reconciled_at - interval '20 seconds'
          where id = ${payment.id}
        `);
        await getPayment(payment.id).expect(200);
        await expect(worker.drain()).resolves.toBe(1);
      }

      const stored = await paymentOf(payment.id);
      expect(stored.reconcileAttempts).toBe(4);
      expect(secondsScheduledAfterCheck(stored)).toBe(
        PENDING_RECONCILE_DELAYS_SECONDS[1],
      );
    });

    it('leaves a payment checked a few seconds ago and a payment just created', async () => {
      const justChecked = await insertDuePayment({
        createdAgoSeconds: 60,
        dueAgoSeconds: -600,
      });
      await db.execute(sql`
        update payments set reconciled_at = clock_timestamp() - interval '5 seconds'
        where id = ${justChecked.id}
      `);
      const justCreated = await insertDuePayment({
        createdAgoSeconds: 5,
        dueAgoSeconds: -600,
      });

      await getPayment(justChecked.id).expect(200);
      await getPayment(justCreated.id).expect(200);

      expect(await isDueNow(justChecked.id)).toBe(false);
      expect(await isDueNow(justCreated.id)).toBe(false);
    });

    it('leaves a payment whose check is still under its lease', async () => {
      const payment = await insertDuePayment({ createdAgoSeconds: 60 });
      const claimed = await app.get(ReconciliationRepository).claimNext([]);
      expect(claimed?.id).toBe(payment.id);
      await db.execute(sql`
        update payments
        set reconciled_at = reconciled_at - interval '20 seconds',
          reconcile_after = reconcile_after - interval '20 seconds'
        where id = ${payment.id}
      `);
      const leased = await paymentOf(payment.id);

      await getPayment(payment.id).expect(200);

      expect((await paymentOf(payment.id)).reconcileAfter).toEqual(
        leased.reconcileAfter,
      );
    });

    it('leaves a payment whose reconciliation stopped', async () => {
      const stopped = await insertDuePayment({ createdAgoSeconds: 60 });
      await db
        .update(payments)
        .set({ reconcileAfter: null })
        .where(eq(payments.id, stopped.id));

      await getPayment(stopped.id).expect(200);

      expect((await paymentOf(stopped.id)).reconcileAfter).toBeNull();
    });
  });

  describe('the worker', () => {
    it(
      'checks a due payment at bootstrap even with a long interval',
      async () => {
        muteLogs();
        const payment = await insertDuePayment();
        const enabledApp = await createE2eApp({
          classOverrides: [TEST_SCOPED_RECONCILIATION],
          isReconciliationEnabled: true,
          reconciliationPollIntervalMs: HOUR_SECONDS * 1000,
        });

        try {
          const deadline = Date.now() + WAIT_DEADLINE_MS;
          while (
            (await paymentOf(payment.id)).status !== 'succeeded' &&
            Date.now() < deadline
          ) {
            await delay(POLL_INTERVAL_MS);
          }

          expect((await paymentOf(payment.id)).status).toBe('succeeded');
        } finally {
          await enabledApp.close();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('idempotency key purge', () => {
    it('deletes only keys past the TTL and leaves their payments', async () => {
      muteLogs();
      const stale = newKey();
      const recent = newKey();
      const fresh = newKey();
      const recentBody = paymentBodyWith();
      const stalePayment = await postPayment(paymentBodyWith(), stale).expect(
        201,
      );
      await postPayment(recentBody, recent).expect(201);
      await postPayment(paymentBodyWith(), fresh).expect(201);
      await ageKey(stale, IDEMPOTENCY_KEY_TTL_SECONDS + 1);
      await ageKey(recent, IDEMPOTENCY_KEY_TTL_SECONDS - HOUR_SECONDS);

      await expect(worker.purge()).resolves.toBeGreaterThanOrEqual(1);

      expect(await keyRowOf(stale)).toBeNull();
      expect(await keyRowOf(recent)).not.toBeNull();
      expect(await keyRowOf(fresh)).not.toBeNull();
      const stalePaymentId = (stalePayment.body as { paymentId: string })
        .paymentId;
      expect(await paymentOf(stalePaymentId)).toBeDefined();
      const replay = await postPayment(recentBody, recent).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
    });
  });

  describeOnRealPostgres('concurrency', () => {
    it(
      'skips a payment locked elsewhere and claims the next',
      async () => {
        const locked = await insertDuePayment({ dueAgoSeconds: 30 });
        const next = await insertDuePayment({ dueAgoSeconds: 10 });
        const lockClient = postgres(databaseUrl, {
          max: 1,
          onnotice: () => {},
        });
        let releaseLock: () => void = () => undefined;
        let markLocked: () => void = () => undefined;
        const isLocked = new Promise<void>((resolve) => {
          markLocked = resolve;
        });
        const holder = lockClient.begin(async (lockSql) => {
          await lockSql`select id from payments where id = ${locked.id} for update`;
          markLocked();
          await new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
        });

        try {
          await isLocked;
          const claim = app.get(ReconciliationRepository).claimNext([]);

          expect(
            await isSettledWithin(claim, LOCK_FREE_CLAIM_DEADLINE_MS),
          ).toBe(true);
          expect((await claim)?.id).toBe(next.id);
        } finally {
          releaseLock();
          await holder;
          await lockClient.end();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'checks each payment once across two concurrent drains',
      async () => {
        muteLogs();
        const getStatus = jest.spyOn(fakeProvider, 'getStatus');
        const due = await Promise.all(
          Array.from({ length: 8 }, () => insertDuePayment()),
        );

        const [firstCount, secondCount] = await Promise.all([
          worker.drain(),
          worker.drain(),
        ]);

        expect(firstCount + secondCount).toBe(due.length);
        expect(getStatus).toHaveBeenCalledTimes(due.length);
        for (const { id } of due) {
          expect((await paymentOf(id)).reconcileAttempts).toBe(1);
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('migration 0008', () => {
    const migrationSqlOf = (): string => {
      const fileName = readdirSync(MIGRATIONS_FOLDER).find((name) =>
        name.startsWith('0008_'),
      );
      if (!fileName) throw new Error('Migration 0008 is missing');

      return readFileSync(join(MIGRATIONS_FOLDER, fileName), 'utf8');
    };

    it('only adds columns, constraints and indexes', () => {
      const statements = migrationSqlOf()
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement !== '');

      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).toMatch(
          /^(ALTER TABLE "\w+" ADD (COLUMN|CONSTRAINT) |CREATE INDEX )/,
        );
      }
    });

    it(
      'gives existing payments zero attempts and a check after the grace',
      async () => {
        const folderBefore0008 = mkdtempSync(join(tmpdir(), 'payvolok-0007-'));
        const database = new PGlite();

        try {
          cpSync(MIGRATIONS_FOLDER, folderBefore0008, { recursive: true });
          const journalPath = join(folderBefore0008, 'meta', '_journal.json');
          const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
            entries: unknown[];
          };
          writeFileSync(
            journalPath,
            JSON.stringify({
              ...journal,
              entries: journal.entries.slice(0, MIGRATIONS_BEFORE_0008),
            }),
          );
          const pgliteDb = drizzlePglite(database);
          await migratePglite(pgliteDb, { migrationsFolder: folderBefore0008 });
          await database.query(`
            insert into payments (provider, purpose, origin, status, amount_minor, currency)
            values ('fake', 'one_off', 'api', 'pending', 1000, 'USD')
          `);

          await migratePglite(pgliteDb, {
            migrationsFolder: MIGRATIONS_FOLDER,
          });

          const { rows } = await database.query<{
            reconcile_attempts: number;
            reconciled_at: Date | null;
            grace_seconds: number;
          }>(`
            select reconcile_attempts, reconciled_at,
              extract(epoch from reconcile_after - clock_timestamp())::float8 as grace_seconds
            from payments
          `);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            reconcile_attempts: 0,
            reconciled_at: null,
          });
          expect(rows[0].grace_seconds).toBeGreaterThan(
            RECONCILE_GRACE_SECONDS - 60,
          );
          expect(rows[0].grace_seconds).toBeLessThanOrEqual(
            RECONCILE_GRACE_SECONDS,
          );
        } finally {
          await database.close();
          rmSync(folderBefore0008, { recursive: true, force: true });
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });
});
