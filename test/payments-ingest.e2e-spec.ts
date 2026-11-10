import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { Logger, type INestApplication } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import postgres from 'postgres';

import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type NewPayment,
  type Payment,
  type PaymentEvent,
} from '@/database/schemas/payments.schema';
import { decideTransition } from '@/payments/payment-state-machine';
import { PaymentsRepository } from '@/payments/payments.repository';
import {
  PaymentEventInvalidError,
  PaymentMismatchError,
  PaymentNotFoundError,
  PaymentProviderRefMismatchError,
  PaymentProviderRefOwnedError,
  PaymentsService,
  type IngestPaymentInput,
} from '@/payments/payments.service';
import { PAYMENT_STATUS_BY_EVENT_TYPE } from '@/payments/provider-event-status';
import { FakeProvider } from '@/providers/fake/fake.provider';
import type { ProviderCode } from '@/providers/provider.constants';
import type {
  ProviderEvent,
  ProviderPaymentEvent,
} from '@/providers/provider-events';
import { ProviderRegistry } from '@/providers/provider.registry';
import {
  RefundsService,
  type IngestRefundInput,
} from '@/refunds/refunds.service';

import { applyMigrations, MIGRATIONS_FOLDER } from './apply-migrations';
import {
  createE2eApp,
  databaseCauseOf,
  databasePoolMax,
  databaseUrl,
  describeOnRealPostgres,
  insertInboxEvent,
  trackSettled,
  waitUntilBlockedBy,
} from './helpers';

const REPO_ROOT = join(__dirname, '..');
const DRIZZLE_KIT_BIN = join(REPO_ROOT, 'node_modules/drizzle-kit/bin.cjs');
const SCHEMA_GLOB = './src/database/schemas/*.schema.ts';
const GENERATE_SCRATCH_FOLDER = '.tmp';

const POOL_WARMUP_SLEEP_SECONDS = 0.1;
const PARALLEL_INGESTS = 20;
const RACE_REPEATS = 10;
const CONNECT_TIMEOUT_SECONDS = 10;
const CLIENT_END_TIMEOUT_SECONDS = 5;
const OVERLONG_SLEEP_SECONDS = 11;
const SLEEP_GUARD_MS = 20000;
const SLOW_TEST_TIMEOUT_MS = 60000;

const OTHER_PROVIDER = 'other' as string as ProviderCode;

const ingestInputWith = (
  overrides: Partial<IngestPaymentInput> = {},
): IngestPaymentInput => ({
  reference: null,
  provider: 'fake',
  providerPaymentId: randomUUID(),
  status: 'succeeded',
  amountMinor: 1000,
  currency: 'USD',
  purpose: 'one_off',
  reason: 'e2e',
  webhookEventId: null,
  ...overrides,
});

const renewalInputWith = (
  overrides: Partial<IngestPaymentInput> = {},
): IngestPaymentInput =>
  ingestInputWith({ purpose: 'subscription_renewal', ...overrides });

const fullRefundInputOf = (
  input: IngestPaymentInput,
  reason: string,
): IngestRefundInput => ({
  reference: null,
  provider: input.provider,
  providerPaymentId: input.providerPaymentId,
  refundReference: null,
  providerRefundId: randomUUID(),
  refundIdentity: 'provider',
  status: 'succeeded',
  amountMinor: input.amountMinor,
  currency: input.currency,
  reason,
  webhookEventId: null,
});

const isPaymentEvent = (event: ProviderEvent): event is ProviderPaymentEvent =>
  event.type in PAYMENT_STATUS_BY_EVENT_TYPE;

const reportFromDrizzleKitGenerate = (): string => {
  mkdirSync(join(REPO_ROOT, GENERATE_SCRATCH_FOLDER), { recursive: true });
  // drizzle-kit joins --out onto the working directory, so it has to be relative.
  const outFolder = relative(
    REPO_ROOT,
    mkdtempSync(join(REPO_ROOT, GENERATE_SCRATCH_FOLDER, 'generate-')),
  );
  const outFolderPath = join(REPO_ROOT, outFolder);

  try {
    cpSync(MIGRATIONS_FOLDER, outFolderPath, { recursive: true });

    return execFileSync(
      process.execPath,
      [
        DRIZZLE_KIT_BIN,
        'generate',
        '--dialect=postgresql',
        `--schema=${SCHEMA_GLOB}`,
        `--out=${outFolder}`,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: SLOW_TEST_TIMEOUT_MS },
    );
  } finally {
    rmSync(outFolderPath, { recursive: true, force: true });
  }
};

describe('Payments ingest', () => {
  let app: INestApplication;
  let db: Database;
  let paymentsService: PaymentsService;
  let refundsService: RefundsService;

  const paymentRowsOf = (
    providerPaymentId: string,
    provider = 'fake',
  ): Promise<Payment[]> =>
    db
      .select()
      .from(payments)
      .where(
        sql`${payments.provider} = ${provider} and ${payments.providerPaymentId} = ${providerPaymentId}`,
      );

  const eventTimelineOf = (paymentId: string): Promise<PaymentEvent[]> =>
    db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, paymentId))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));

  const insertNullRefPayment = async (
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

  const storedPaymentOf = async (paymentId: string): Promise<Payment> => {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment;
  };

  const insertPaymentSql = (
    overrides: Partial<
      Record<'status' | 'purpose' | 'origin' | 'currency', string>
    > & { amountMinor?: number } = {},
  ) =>
    db.execute(sql`
      insert into payments
        (provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
      values (
        'fake',
        ${randomUUID()},
        ${overrides.purpose ?? 'one_off'},
        ${overrides.origin ?? 'demo'},
        ${overrides.status ?? 'succeeded'},
        ${overrides.amountMinor ?? 1000},
        ${overrides.currency ?? 'USD'}
      )
    `);

  // On a cold pool the first transaction commits before other connections
  // open, so the ingests would run one after another and prove nothing.
  const warmPool = async (): Promise<void> => {
    await Promise.all(
      Array.from({ length: databasePoolMax }, () =>
        db.execute(sql`select pg_sleep(${POOL_WARMUP_SLEEP_SECONDS})`),
      ),
    );
  };

  beforeAll(async () => {
    app = await createE2eApp();
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

  describe('migrations', () => {
    it(
      'apply from empty and are a no-op on a second run',
      async () => {
        const emptyDatabase = new PGlite();

        try {
          const emptyDrizzle = drizzlePglite(emptyDatabase);
          await migratePglite(emptyDrizzle, {
            migrationsFolder: MIGRATIONS_FOLDER,
          });
          const firstRunRows = await emptyDatabase.query(
            'select id, hash from drizzle.__drizzle_migrations order by id',
          );
          await migratePglite(emptyDrizzle, {
            migrationsFolder: MIGRATIONS_FOLDER,
          });
          const secondRunRows = await emptyDatabase.query(
            'select id, hash from drizzle.__drizzle_migrations order by id',
          );
          const tables = await emptyDatabase.query<{ name: string }>(
            `select tablename as name from pg_tables where schemaname = 'public' order by tablename`,
          );

          expect(firstRunRows.rows).toHaveLength(8);
          expect(secondRunRows.rows).toEqual(firstRunRows.rows);
          expect(tables.rows.map(({ name }) => name)).toEqual([
            'idempotency_keys',
            'payment_events',
            'payments',
            'refunds',
            'webhook_events',
          ]);
        } finally {
          await emptyDatabase.close();
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'are a no-op when applied again to the target database',
      async () => {
        const migrationRowsSql = sql`select id, hash from drizzle.__drizzle_migrations order by id`;
        const rowsBefore = await db.execute(migrationRowsSql);

        await applyMigrations(databaseUrl);

        expect(rowsBefore).toHaveLength(8);
        expect(await db.execute(migrationRowsSql)).toEqual(rowsBefore);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'leave no schema changes for drizzle-kit to generate',
      () => {
        expect(reportFromDrizzleKitGenerate()).toContain('No schema changes');
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('ingestPayment', () => {
    it('creates a payment and a birth event for an unknown key', async () => {
      const input = ingestInputWith({
        status: 'succeeded',
        purpose: 'subscription_renewal',
      });

      const { payment, outcome } = await paymentsService.ingestPayment(input);

      expect(outcome).toBe('created');
      expect(payment).toMatchObject({
        status: 'succeeded',
        purpose: 'subscription_renewal',
        amountMinor: 1000,
      });
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      const events = await eventTimelineOf(payment.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'succeeded',
        outcome: 'applied',
      });
    });

    it('creates a separate payment for the same id under another provider', async () => {
      const providerPaymentId = randomUUID();

      const first = await paymentsService.ingestPayment(
        renewalInputWith({ provider: 'fake', providerPaymentId }),
      );
      const second = await paymentsService.ingestPayment(
        renewalInputWith({ provider: OTHER_PROVIDER, providerPaymentId }),
      );

      expect(second.outcome).toBe('created');
      expect(second.payment.id).not.toBe(first.payment.id);
    });

    it('lets two rows with a null provider_payment_id coexist under one provider', async () => {
      const provider = `null-ref-${randomUUID()}` as ProviderCode;
      const nullRefRow = {
        provider,
        providerPaymentId: null,
        purpose: 'one_off',
        origin: 'api',
        status: 'created',
        amountMinor: 1000,
        currency: 'USD',
      } as const;

      await db.insert(payments).values([nullRefRow, nullRefRow]);

      expect(
        await db.select().from(payments).where(eq(payments.provider, provider)),
      ).toHaveLength(2);
    });

    it('returns duplicate for the same status and writes nothing', async () => {
      const input = renewalInputWith();
      const { payment } = await paymentsService.ingestPayment(input);

      const repeat = await paymentsService.ingestPayment(input);

      expect(repeat.outcome).toBe('duplicate');
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      expect(await eventTimelineOf(payment.id)).toHaveLength(1);
    });

    it('records a stale fact once per webhook event and keeps the status', async () => {
      const input = renewalInputWith({ status: 'succeeded' });
      const { payment } = await paymentsService.ingestPayment(input);
      const staleInput = {
        ...input,
        status: 'pending',
        webhookEventId: await insertInboxEvent(db),
      } as const;

      const stale = await paymentsService.ingestPayment(staleInput);
      const repeatedStale = await paymentsService.ingestPayment(staleInput);

      expect(stale.outcome).toBe('stale');
      expect(repeatedStale.outcome).toBe('stale');
      expect(stale.payment.status).toBe('succeeded');
      const staleEvents = (await eventTimelineOf(payment.id)).filter(
        ({ outcome }) => outcome === 'stale',
      );
      expect(staleEvents).toHaveLength(1);
      expect(staleEvents[0]).toMatchObject({
        fromStatus: 'succeeded',
        toStatus: 'pending',
      });
    });

    it('records and logs a conflict and keeps the status', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const input = renewalInputWith({ status: 'expired' });
      const { payment } = await paymentsService.ingestPayment(input);

      const conflict = await paymentsService.ingestPayment({
        ...input,
        status: 'succeeded',
      });

      expect(conflict.outcome).toBe('conflict');
      expect(conflict.payment.status).toBe('expired');
      const events = await eventTimelineOf(payment.id);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        fromStatus: 'expired',
        toStatus: 'succeeded',
        outcome: 'conflict',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(payment.id));
    });

    it('builds an ordered timeline of applied events', async () => {
      const input = renewalInputWith({
        status: 'pending',
        reason: 'birth reason',
      });
      const { payment } = await paymentsService.ingestPayment(input);

      await paymentsService.ingestPayment({
        ...input,
        status: 'succeeded',
        reason: 'capture reason',
      });
      const refunded = await refundsService.ingestRefund(
        fullRefundInputOf(input, 'refund reason'),
      );

      expect(refunded.payment.status).toBe('refunded');
      expect(refunded.payment.updatedAt.getTime()).toBeGreaterThan(
        payment.updatedAt.getTime(),
      );
      const events = await eventTimelineOf(payment.id);
      expect(
        events.map(({ fromStatus, toStatus, outcome, reason }) => [
          fromStatus,
          toStatus,
          outcome,
          reason,
        ]),
      ).toEqual([
        [null, 'pending', 'applied', 'birth reason'],
        ['pending', 'succeeded', 'applied', 'capture reason'],
        ['succeeded', 'refunded', 'applied', 'refund reason'],
      ]);
    });

    it.each([
      ['amountMinor', 'succeeded', 2000, 'USD'],
      ['currency', 'succeeded', 1000, 'EUR'],
      ['amountMinor', 'pending', 2000, 'USD'],
      ['currency', 'pending', 1000, 'EUR'],
    ] as const)(
      'rejects a different %s on an ingest of %s and writes nothing',
      async (_field, status, amountMinor, currency) => {
        const input = renewalInputWith({ status: 'pending' });
        const { payment } = await paymentsService.ingestPayment(input);

        const error: unknown = await paymentsService
          .ingestPayment({ ...input, status, amountMinor, currency })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(PaymentMismatchError);
        expect(error).toMatchObject({
          message: `Payment ${payment.id} mismatch: stored 1000 USD, received ${amountMinor} ${currency}`,
          paymentId: payment.id,
          storedAmountMinor: 1000,
          storedCurrency: 'USD',
          receivedAmountMinor: amountMinor,
          receivedCurrency: currency,
        });

        const [storedPayment] = await paymentRowsOf(input.providerPaymentId);
        expect(storedPayment).toMatchObject({
          status: 'pending',
          amountMinor: 1000,
          currency: 'USD',
        });
        expect(await eventTimelineOf(payment.id)).toHaveLength(1);
      },
    );

    it.each([
      ['a lowercase currency', 'usd', { currency: 'usd' }],
      ['an unsafe amount', '9007199254740992', { amountMinor: 2 ** 53 }],
    ])('rejects %s and writes nothing', async (_case, rawValue, overrides) => {
      const input = ingestInputWith(overrides);

      const error: unknown = await paymentsService
        .ingestPayment(input)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PaymentEventInvalidError);
      expect((error as Error).message).not.toContain(rawValue);
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(0);
    });

    it('leaves no payment when the birth event insert fails', async () => {
      const input = renewalInputWith({ webhookEventId: 'not-a-uuid' });

      const cause = await databaseCauseOf(() =>
        paymentsService.ingestPayment(input),
      );

      expect(cause.code).toBe('22P02');
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(0);
    });

    it('serialises parallel duplicate ingests into one payment and one birth event', async () => {
      const input = renewalInputWith();
      await warmPool();

      const results = await Promise.all(
        Array.from({ length: PARALLEL_INGESTS }, () =>
          paymentsService.ingestPayment(input),
        ),
      );

      const outcomes = results.map(({ outcome }) => outcome).sort();
      expect(outcomes).toEqual([
        'created',
        ...Array.from({ length: PARALLEL_INGESTS - 1 }, () => 'duplicate'),
      ]);
      const paymentRows = await paymentRowsOf(input.providerPaymentId);
      expect(paymentRows).toHaveLength(1);
      expect(await eventTimelineOf(paymentRows[0].id)).toHaveLength(1);
    });

    it('stores the webhook_event_id of a real inbox row', async () => {
      const webhookEventId = await insertInboxEvent(db);

      const { payment } = await paymentsService.ingestPayment(
        renewalInputWith({ webhookEventId }),
      );

      const [birthEvent] = await eventTimelineOf(payment.id);
      expect(birthEvent.webhookEventId).toBe(webhookEventId);
    });
  });

  describe('provider event statuses', () => {
    it('ends at succeeded after a failed attempt', async () => {
      const input = renewalInputWith({
        status: PAYMENT_STATUS_BY_EVENT_TYPE['payment.attempt_failed'],
      });
      const { payment } = await paymentsService.ingestPayment(input);

      const { outcome, payment: finalPayment } =
        await paymentsService.ingestPayment({
          ...input,
          status: PAYMENT_STATUS_BY_EVENT_TYPE['payment.succeeded'],
        });

      expect(payment.status).toBe('pending');
      expect(outcome).toBe('applied');
      expect(finalPayment.status).toBe('succeeded');
    });

    it('stays failed with a conflict event when succeeded follows failed', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const input = renewalInputWith({
        status: PAYMENT_STATUS_BY_EVENT_TYPE['payment.failed'],
      });
      const { payment } = await paymentsService.ingestPayment(input);

      const { outcome, payment: finalPayment } =
        await paymentsService.ingestPayment({
          ...input,
          status: PAYMENT_STATUS_BY_EVENT_TYPE['payment.succeeded'],
        });

      expect(outcome).toBe('conflict');
      expect(finalPayment.status).toBe('failed');
      const events = await eventTimelineOf(payment.id);
      expect(events[events.length - 1]).toMatchObject({
        fromStatus: 'failed',
        toStatus: 'succeeded',
        outcome: 'conflict',
      });
    });
  });

  describe('ingest by reference', () => {
    it('links a null-ref row when the webhook arrives first', async () => {
      const row = await insertNullRefPayment();
      const providerPaymentId = randomUUID();

      const { outcome, payment } = await paymentsService.ingestPayment(
        ingestInputWith({ reference: row.id, providerPaymentId }),
      );

      expect(outcome).toBe('applied');
      expect(payment).toMatchObject({
        id: row.id,
        providerPaymentId,
        status: 'succeeded',
      });
      expect(await storedPaymentOf(row.id)).toMatchObject({
        providerPaymentId,
        status: 'succeeded',
      });
      expect(await paymentRowsOf(providerPaymentId)).toHaveLength(1);
      const events = await eventTimelineOf(row.id);
      expect(
        events.map(({ fromStatus, toStatus }) => [fromStatus, toStatus]),
      ).toEqual([['created', 'succeeded']]);
    });

    it('runs the real fake flow from createPayment to a succeeded payment', async () => {
      const fakeProvider = app.get(FakeProvider);
      const row = await insertNullRefPayment();
      const { providerPaymentId } = await fakeProvider.createPayment({
        reference: row.id,
        amountMinor: row.amountMinor,
        currency: row.currency,
        description: 'e2e',
        returnUrl: 'https://example.test/return',
        webhookUrl: 'https://example.test/webhook',
      });

      for (const webhook of fakeProvider.buildPaymentWebhooks(
        providerPaymentId,
        new Date(),
      )) {
        expect(await fakeProvider.verifyWebhook(webhook)).toBe(true);

        for (const event of fakeProvider.parseWebhook(webhook)) {
          if (!isPaymentEvent(event)) throw new Error(`Got ${event.type}`);

          await paymentsService.ingestPayment(
            ingestInputWith({
              reference: event.reference,
              providerPaymentId: event.providerPaymentId,
              status: PAYMENT_STATUS_BY_EVENT_TYPE[event.type],
              amountMinor: event.amountMinor,
              currency: event.currency,
            }),
          );
        }
      }

      expect(await paymentRowsOf(providerPaymentId)).toHaveLength(1);
      expect(await storedPaymentOf(row.id)).toMatchObject({
        providerPaymentId,
        status: 'succeeded',
      });
      const events = await eventTimelineOf(row.id);
      expect(
        events.map(({ fromStatus, toStatus }) => [fromStatus, toStatus]),
      ).toEqual([
        ['created', 'pending'],
        ['pending', 'succeeded'],
      ]);
    });

    it('persists the id and keeps the status on a conflict with a terminal row', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const row = await insertNullRefPayment({ status: 'expired' });
      const providerPaymentId = randomUUID();

      const { outcome, payment } = await paymentsService.ingestPayment(
        ingestInputWith({
          reference: row.id,
          providerPaymentId,
          status: 'succeeded',
        }),
      );

      expect(outcome).toBe('conflict');
      expect(payment).toMatchObject({
        id: row.id,
        providerPaymentId,
        status: 'expired',
      });
      expect(await storedPaymentOf(row.id)).toMatchObject({
        providerPaymentId,
        status: 'expired',
      });
      const events = await eventTimelineOf(row.id);
      expect(
        events.map(({ fromStatus, toStatus, outcome: eventOutcome }) => [
          fromStatus,
          toStatus,
          eventOutcome,
        ]),
      ).toEqual([['expired', 'succeeded', 'conflict']]);
    });

    it('persists the id even when the status decision is duplicate', async () => {
      const row = await insertNullRefPayment({ status: 'pending' });
      const providerPaymentId = randomUUID();

      const { outcome, payment } = await paymentsService.ingestPayment(
        ingestInputWith({
          reference: row.id,
          providerPaymentId,
          status: 'pending',
        }),
      );

      expect(outcome).toBe('duplicate');
      expect(payment.providerPaymentId).toBe(providerPaymentId);
      expect((await storedPaymentOf(row.id)).providerPaymentId).toBe(
        providerPaymentId,
      );
      expect(await eventTimelineOf(row.id)).toHaveLength(0);
    });

    it(
      'resolves parallel ingests of one reference into one applied and no second event',
      async () => {
        const row = await insertNullRefPayment();
        const input = ingestInputWith({ reference: row.id });
        await warmPool();

        const results = await Promise.all(
          Array.from({ length: PARALLEL_INGESTS }, () =>
            paymentsService.ingestPayment(input),
          ),
        );

        const outcomes = results.map(({ outcome }) => outcome).sort();
        expect(outcomes).toEqual([
          'applied',
          ...Array.from({ length: PARALLEL_INGESTS - 1 }, () => 'duplicate'),
        ]);
        expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
        expect(await eventTimelineOf(row.id)).toHaveLength(1);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it('rolls the link back when the amount differs', async () => {
      const row = await insertNullRefPayment();

      await expect(
        paymentsService.ingestPayment(
          ingestInputWith({ reference: row.id, amountMinor: 2000 }),
        ),
      ).rejects.toBeInstanceOf(PaymentMismatchError);

      expect(await storedPaymentOf(row.id)).toMatchObject({
        providerPaymentId: null,
        status: 'created',
      });
      expect(await eventTimelineOf(row.id)).toHaveLength(0);
    });

    it('rejects a different id on a linked row and writes nothing', async () => {
      const storedId = randomUUID();
      const row = await insertNullRefPayment({ providerPaymentId: storedId });

      await expect(
        paymentsService.ingestPayment(ingestInputWith({ reference: row.id })),
      ).rejects.toBeInstanceOf(PaymentProviderRefMismatchError);

      expect(await storedPaymentOf(row.id)).toMatchObject({
        providerPaymentId: storedId,
        status: 'created',
      });
      expect(await eventTimelineOf(row.id)).toHaveLength(0);
    });

    it('throws the owned error on every attempt and rolls back when another row owns the id', async () => {
      const ownedId = randomUUID();
      const owner = await insertNullRefPayment({ providerPaymentId: ownedId });
      const row = await insertNullRefPayment();
      const input = ingestInputWith({
        reference: row.id,
        providerPaymentId: ownedId,
      });

      await expect(paymentsService.ingestPayment(input)).rejects.toBeInstanceOf(
        PaymentProviderRefOwnedError,
      );
      await expect(paymentsService.ingestPayment(input)).rejects.toBeInstanceOf(
        PaymentProviderRefOwnedError,
      );

      expect(await storedPaymentOf(row.id)).toMatchObject({
        providerPaymentId: null,
        status: 'created',
      });
      expect(await storedPaymentOf(owner.id)).toMatchObject({
        providerPaymentId: ownedId,
        status: 'created',
      });
      expect(await eventTimelineOf(row.id)).toHaveLength(0);
      expect(await eventTimelineOf(owner.id)).toHaveLength(0);
    });

    it.each([
      ['a non-uuid reference', () => 'attempt-1'],
      ['an unknown uuid', () => randomUUID()],
    ])(
      'throws not-found on a one-off and births on a renewal for %s',
      async (_case, reference) => {
        const input = ingestInputWith({ reference: reference() });

        await expect(
          paymentsService.ingestPayment(input),
        ).rejects.toBeInstanceOf(PaymentNotFoundError);
        expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(0);

        const { outcome, payment } = await paymentsService.ingestPayment({
          ...input,
          purpose: 'subscription_renewal',
        });

        expect(outcome).toBe('created');
        expect(payment.providerPaymentId).toBe(input.providerPaymentId);
        expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      },
    );

    it('throws not-found on a one-off, births on a renewal and leaves the row alone for another provider', async () => {
      const otherRow = await insertNullRefPayment({
        provider: OTHER_PROVIDER,
      });
      const input = ingestInputWith({ reference: otherRow.id });

      await expect(paymentsService.ingestPayment(input)).rejects.toBeInstanceOf(
        PaymentNotFoundError,
      );
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(0);

      const { outcome, payment } = await paymentsService.ingestPayment({
        ...input,
        purpose: 'subscription_renewal',
      });

      expect(outcome).toBe('created');
      expect(payment.id).not.toBe(otherRow.id);
      expect(await storedPaymentOf(otherRow.id)).toEqual(otherRow);
      expect(await eventTimelineOf(otherRow.id)).toHaveLength(0);
    });
  });

  describe('one-off events', () => {
    it('writes nothing without a reference, then a referenced event applies to our row', async () => {
      const row = await insertNullRefPayment();
      const input = ingestInputWith({ reference: null });

      await expect(paymentsService.ingestPayment(input)).rejects.toBeInstanceOf(
        PaymentNotFoundError,
      );
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(0);

      const { outcome, payment } = await paymentsService.ingestPayment({
        ...input,
        reference: row.id,
      });

      expect(outcome).toBe('applied');
      expect(payment).toMatchObject({
        id: row.id,
        providerPaymentId: input.providerPaymentId,
        status: 'succeeded',
      });
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      const events = await eventTimelineOf(row.id);
      expect(
        events.map(({ fromStatus, toStatus }) => [fromStatus, toStatus]),
      ).toEqual([['created', 'succeeded']]);
    });

    it('applies on a retry once the row appears by provider id', async () => {
      const input = ingestInputWith();

      await expect(paymentsService.ingestPayment(input)).rejects.toBeInstanceOf(
        PaymentNotFoundError,
      );
      const row = await insertNullRefPayment({
        providerPaymentId: input.providerPaymentId,
        status: 'pending',
      });

      const { outcome, payment } = await paymentsService.ingestPayment(input);

      expect(outcome).toBe('applied');
      expect(payment).toMatchObject({ id: row.id, status: 'succeeded' });
    });

    it('returns duplicate for the same status on a stored row', async () => {
      const input = ingestInputWith({ status: 'pending' });
      const row = await insertNullRefPayment({
        providerPaymentId: input.providerPaymentId,
        status: 'pending',
      });

      const { outcome } = await paymentsService.ingestPayment(input);

      expect(outcome).toBe('duplicate');
      expect(await eventTimelineOf(row.id)).toHaveLength(0);
    });

    it('records a late event as stale once on a stored row', async () => {
      const input = ingestInputWith({
        status: 'pending',
        webhookEventId: await insertInboxEvent(db),
      });
      const row = await insertNullRefPayment({
        providerPaymentId: input.providerPaymentId,
        status: 'succeeded',
      });

      const stale = await paymentsService.ingestPayment(input);
      const repeatedStale = await paymentsService.ingestPayment(input);

      expect(stale.outcome).toBe('stale');
      expect(repeatedStale.outcome).toBe('stale');
      expect(await eventTimelineOf(row.id)).toHaveLength(1);
    });

    it('records and logs a conflict for succeeded after expired on a stored row', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const input = ingestInputWith();
      const row = await insertNullRefPayment({
        providerPaymentId: input.providerPaymentId,
        status: 'expired',
      });

      const { outcome, payment } = await paymentsService.ingestPayment(input);

      expect(outcome).toBe('conflict');
      expect(payment.status).toBe('expired');
      expect(await eventTimelineOf(row.id)).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(row.id));
    });

    it('rejects a different amount on a stored row', async () => {
      const input = ingestInputWith({ amountMinor: 2000 });
      const row = await insertNullRefPayment({
        providerPaymentId: input.providerPaymentId,
        status: 'pending',
      });

      await expect(paymentsService.ingestPayment(input)).rejects.toBeInstanceOf(
        PaymentMismatchError,
      );

      expect((await storedPaymentOf(row.id)).status).toBe('pending');
    });
  });

  describe('renewal events', () => {
    it('births an unknown renewal with the provider origin and a repeat is duplicate', async () => {
      const input = renewalInputWith();

      const { outcome, payment } = await paymentsService.ingestPayment(input);
      const repeat = await paymentsService.ingestPayment(input);

      expect(outcome).toBe('created');
      expect(payment).toMatchObject({
        origin: 'provider',
        purpose: 'subscription_renewal',
      });
      expect(repeat.outcome).toBe('duplicate');
      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      expect(await eventTimelineOf(payment.id)).toHaveLength(1);
    });

    it('applies a renewal to the referenced row and births nothing', async () => {
      const row = await insertNullRefPayment({
        purpose: 'subscription_renewal',
      });
      const input = renewalInputWith({ reference: row.id });

      const { outcome, payment } = await paymentsService.ingestPayment(input);

      expect(outcome).toBe('applied');
      expect(payment.id).toBe(row.id);
      const ownerRows = await paymentRowsOf(input.providerPaymentId);
      expect(ownerRows).toHaveLength(1);
      expect(ownerRows[0]).toMatchObject({
        id: row.id,
        origin: 'api',
        status: 'succeeded',
      });
      const events = await eventTimelineOf(row.id);
      expect(
        events.map(({ fromStatus, toStatus }) => [fromStatus, toStatus]),
      ).toEqual([['created', 'succeeded']]);
    });

    it('does not birth a subscription_initial event', async () => {
      const input = ingestInputWith({ purpose: 'subscription_initial' });

      await expect(paymentsService.ingestPayment(input)).rejects.toBeInstanceOf(
        PaymentNotFoundError,
      );

      expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(0);
    });
  });

  describe('database constraints', () => {
    it.each([
      ['status', { status: 'bogus' }],
      ['purpose', { purpose: 'bogus' }],
      ['origin', { origin: 'bogus' }],
      ['negative amount_minor', { amountMinor: -1 }],
      ['lowercase currency', { currency: 'usd' }],
    ])('rejects a bad %s', async (_field, badValue) => {
      const cause = await databaseCauseOf(() => insertPaymentSql(badValue));

      expect(cause.code).toBe('23514');
    });

    it('accepts the valid row those rejections are measured against', async () => {
      await expect(insertPaymentSql()).resolves.toBeDefined();
    });

    it('accepts the provider origin', async () => {
      await expect(
        insertPaymentSql({ origin: 'provider' }),
      ).resolves.toBeDefined();
    });

    it('rejects an update of payment_events as append-only', async () => {
      const { payment } =
        await paymentsService.ingestPayment(renewalInputWith());

      const cause = await databaseCauseOf(() =>
        db
          .update(paymentEvents)
          .set({ reason: 'rewritten' })
          .where(eq(paymentEvents.paymentId, payment.id)),
      );

      expect(cause.message).toContain('append-only');
    });

    it('allows deleting an event', async () => {
      const { payment } =
        await paymentsService.ingestPayment(renewalInputWith());

      await db
        .delete(paymentEvents)
        .where(eq(paymentEvents.paymentId, payment.id));

      expect(await eventTimelineOf(payment.id)).toHaveLength(0);
    });

    it('rejects deleting a payment that has events', async () => {
      const { payment } =
        await paymentsService.ingestPayment(renewalInputWith());

      const cause = await databaseCauseOf(() =>
        db.delete(payments).where(eq(payments.id, payment.id)),
      );

      expect(cause.code).toBe('23503');
    });

    it('raises 23505 when a payment event reuses an existing id', async () => {
      const { payment } =
        await paymentsService.ingestPayment(renewalInputWith());
      const [birthEvent] = await eventTimelineOf(payment.id);

      const cause = await databaseCauseOf(() =>
        app.get(PaymentsRepository).withTransaction((tx) =>
          app.get(PaymentsRepository).insertEvent(tx, {
            id: birthEvent.id,
            paymentId: payment.id,
            fromStatus: 'succeeded',
            toStatus: 'pending',
            outcome: 'stale',
            reason: 'reused id',
          }),
        ),
      );

      expect(cause.code).toBe('23505');
      expect(await eventTimelineOf(payment.id)).toEqual([birthEvent]);
    });

    it('stores the statement timeout on the role', async () => {
      const [{ role_config: roleConfig }] = await db.execute<{
        role_config: string;
      }>(sql`
        select array_to_string(rolconfig, ',') as role_config
        from pg_roles
        where rolname = current_user
      `);

      expect(roleConfig.split(',')).toContain('statement_timeout=10s');
    });
  });

  describe('application wiring', () => {
    it('boots with PaymentsModule and adds only the payment routes', () => {
      const httpInstance = app.getHttpAdapter().getInstance() as {
        router: { stack: { route?: { path: string } }[] };
      };

      const routePaths = httpInstance.router.stack
        .flatMap(({ route }) => (route ? [route.path] : []))
        .sort();

      expect(paymentsService).toBeInstanceOf(PaymentsService);
      expect(routePaths).toEqual([
        '/api/v1/payments',
        '/api/v1/payments/:id',
        '/health/live',
        '/health/ready',
        '/webhooks/:provider',
      ]);
    });

    it('registers the injected fake provider', () => {
      expect(app.get(ProviderRegistry).get('fake')).toBe(app.get(FakeProvider));
    });
  });

  describeOnRealPostgres('real Postgres concurrency', () => {
    let holdingClient: postgres.Sql;

    const newClient = (): postgres.Sql =>
      postgres(databaseUrl, {
        max: 1,
        prepare: false,
        connect_timeout: CONNECT_TIMEOUT_SECONDS,
        onnotice: () => {},
      });

    const holdUncommittedInsert = async (input: IngestPaymentInput) => {
      const connection = await holdingClient.reserve();
      await connection.unsafe('begin');
      await connection`
        insert into payments
          (provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
        values (
          ${input.provider},
          ${input.providerPaymentId},
          ${input.purpose},
          'provider',
          'pending',
          ${input.amountMinor},
          ${input.currency}
        )
      `;
      const [{ pid }] = await connection<{ pid: number }[]>`
        select pg_backend_pid() as pid
      `;

      return {
        pid,
        commit: () => connection.unsafe('commit'),
        rollback: () => connection.unsafe('rollback'),
        release: async () => {
          await connection.unsafe('rollback');
          connection.release();
        },
      };
    };

    beforeAll(() => {
      holdingClient = newClient();
    });

    afterAll(async () => {
      await holdingClient.end({ timeout: CLIENT_END_TIMEOUT_SECONDS });
    });

    it('waits on an uncommitted insert and resolves against the committed row', async () => {
      const input = renewalInputWith({ status: 'succeeded' });
      const held = await holdUncommittedInsert(input);

      try {
        const ingest = trackSettled(paymentsService.ingestPayment(input));

        expect(await waitUntilBlockedBy(db, held.pid)).toBe(true);
        expect(ingest.isSettled).toBe(false);

        await held.commit();
        const { payment, outcome } = await ingest.work;

        expect(outcome).toBe('applied');
        expect(payment.status).toBe('succeeded');
        expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      } finally {
        await held.release();
      }
    });

    it('waits on an uncommitted insert and creates the payment after a rollback', async () => {
      const input = renewalInputWith({ status: 'succeeded' });
      const held = await holdUncommittedInsert(input);

      try {
        const ingest = trackSettled(paymentsService.ingestPayment(input));

        expect(await waitUntilBlockedBy(db, held.pid)).toBe(true);
        expect(ingest.isSettled).toBe(false);

        await held.rollback();
        const { payment, outcome } = await ingest.work;

        expect(outcome).toBe('created');
        expect(payment.status).toBe('succeeded');
        expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      } finally {
        await held.release();
      }
    });

    it('does not wait on an uncommitted insert for a one-off and applies on the retry after commit', async () => {
      const input = ingestInputWith({ status: 'succeeded' });
      const held = await holdUncommittedInsert(input);

      try {
        await expect(
          paymentsService.ingestPayment(input),
        ).rejects.toBeInstanceOf(PaymentNotFoundError);

        await held.commit();
        const { payment, outcome } = await paymentsService.ingestPayment(input);

        expect(outcome).toBe('applied');
        expect(payment.status).toBe('succeeded');
        expect(await paymentRowsOf(input.providerPaymentId)).toHaveLength(1);
      } finally {
        await held.release();
      }
    });

    it(
      'resolves parallel one-off events on a pending row into one applied and one event',
      async () => {
        const input = ingestInputWith();
        const row = await insertNullRefPayment({
          providerPaymentId: input.providerPaymentId,
          status: 'pending',
        });
        await warmPool();

        const results = await Promise.all(
          Array.from({ length: PARALLEL_INGESTS }, () =>
            paymentsService.ingestPayment(input),
          ),
        );

        const outcomes = results.map(({ outcome }) => outcome).sort();
        expect(outcomes).toEqual([
          'applied',
          ...Array.from({ length: PARALLEL_INGESTS - 1 }, () => 'duplicate'),
        ]);
        expect(await eventTimelineOf(row.id)).toHaveLength(1);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it('waits on a row lock and decides against the row linked meanwhile', async () => {
      const row = await insertNullRefPayment();
      const input = ingestInputWith({ reference: row.id });
      const connection = await holdingClient.reserve();

      try {
        await connection.unsafe('begin');
        await connection`
          update payments
          set provider_payment_id = ${input.providerPaymentId}, status = 'succeeded'
          where id = ${row.id}
        `;
        const [{ pid }] = await connection<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        const ingest = trackSettled(paymentsService.ingestPayment(input));

        expect(await waitUntilBlockedBy(db, pid)).toBe(true);
        expect(ingest.isSettled).toBe(false);

        await connection.unsafe('commit');
        const { outcome, payment } = await ingest.work;

        expect(outcome).toBe('duplicate');
        expect(payment).toMatchObject({
          providerPaymentId: input.providerPaymentId,
          status: 'succeeded',
        });
      } finally {
        await connection.unsafe('rollback');
        connection.release();
      }
    });

    it(
      'resolves parallel ingests with one created and no unique violation',
      async () => {
        const input = renewalInputWith();
        await warmPool();

        const results = await Promise.all(
          Array.from({ length: PARALLEL_INGESTS }, () =>
            paymentsService.ingestPayment(input),
          ),
        );

        const outcomes = results.map(({ outcome }) => outcome).sort();
        expect(outcomes).toEqual([
          'created',
          ...Array.from({ length: PARALLEL_INGESTS - 1 }, () => 'duplicate'),
        ]);
        const paymentRows = await paymentRowsOf(input.providerPaymentId);
        expect(paymentRows).toHaveLength(1);
        const events = await eventTimelineOf(paymentRows[0].id);
        expect(events).toHaveLength(1);
        expect(events[0].fromStatus).toBeNull();
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'always ends at refunded when succeeded and a full refund race',
      async () => {
        await warmPool();

        for (let repeat = 0; repeat < RACE_REPEATS; repeat += 1) {
          const input = renewalInputWith({ status: 'pending' });
          const { payment } = await paymentsService.ingestPayment(input);

          await Promise.all([
            paymentsService.ingestPayment({ ...input, status: 'succeeded' }),
            refundsService.ingestRefund(fullRefundInputOf(input, 'e2e refund')),
          ]);

          const [storedPayment] = await paymentRowsOf(input.providerPaymentId);
          expect(storedPayment.status).toBe('refunded');

          const appliedEvents = (await eventTimelineOf(payment.id)).filter(
            ({ outcome }) => outcome === 'applied',
          );
          const transitions = appliedEvents.flatMap(
            ({ fromStatus, toStatus }) =>
              fromStatus ? [decideTransition(fromStatus, toStatus)] : [],
          );
          expect(new Set(transitions)).toEqual(new Set(['apply']));

          expect(appliedEvents[0].fromStatus).toBeNull();
          appliedEvents.slice(1).forEach(({ fromStatus }, index) => {
            expect(fromStatus).toBe(appliedEvents[index].toStatus);
          });
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'enforces the role statement timeout on a fresh connection',
      async () => {
        const freshClient = newClient();
        let guardTimer: NodeJS.Timeout | undefined;

        try {
          const [{ statement_timeout: statementTimeout }] = await freshClient<
            { statement_timeout: string }[]
          >`show statement_timeout`;
          expect(statementTimeout).toBe('10s');

          const guard = new Promise<'guard expired'>((resolve) => {
            guardTimer = setTimeout(
              () => resolve('guard expired'),
              SLEEP_GUARD_MS,
            );
          });
          const sleepResult = await Promise.race([
            freshClient`select pg_sleep(${OVERLONG_SLEEP_SECONDS})`.then(
              () => 'slept',
              (error: { code?: string }) => error.code,
            ),
            guard,
          ]);

          expect(sleepResult).toBe('57014');
        } finally {
          clearTimeout(guardTimer);
          await freshClient.end({ timeout: CLIENT_END_TIMEOUT_SECONDS });
        }
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });
});
