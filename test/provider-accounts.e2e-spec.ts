import { createHash, randomInt, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type NewPayment,
  type Payment,
} from '@/database/schemas/payments.schema';
import { providerAccounts } from '@/database/schemas/provider-accounts.schema';
import { refunds } from '@/database/schemas/refunds.schema';
import {
  webhookEvents,
  type WebhookEvent,
} from '@/database/schemas/webhook-events.schema';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_PADDLE_ACCOUNT_ID,
} from '@/provider-accounts/provider-accounts.constants';
import {
  ProviderAccountsRepository,
  type StoredAccount,
} from '@/provider-accounts/provider-accounts.repository';
import { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import { encodeFakeId } from '@/providers/fake/fake-wire-format';
import type { WebhookRequest } from '@/providers/payment-provider.port';
import { ReconciliationWorker } from '@/reconciliation/reconciliation.worker';

import {
  createE2eApp,
  deliverTo,
  FAKE_SIGNATURE_HEADER,
  serverOf,
  TEST_API_KEY,
  type FakeSigner,
} from './helpers';
import { scopedReconciliation } from './scoped-reconciliation';
import {
  FAKE_A_CREDENTIALS_REF,
  twoProjects,
  type TestAccount,
} from './two-projects';
import { tick } from './webhook-replay';

const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const INVALID_ROWS_CAP = 20;
const SLOW_TEST_TIMEOUT_MS = 60000;
const HOUR_SECONDS = 60 * 60;

const uniqueAmountMinor = (): number => randomInt(10_000, 10_000_000) * 100;

const invalidKeyOf = (rawBody: Buffer): string =>
  `invalid:${createHash('sha256').update(rawBody).digest('hex')}`;

const signatureOf = (webhook: WebhookRequest): string =>
  webhook.headers[FAKE_SIGNATURE_HEADER] as string;

type PaymentEventFacts = {
  type?: string;
  purpose?: string;
  reference: string | null;
  providerPaymentId: string;
  amountMinor: number;
};

const paymentWebhookOf = (
  signer: FakeSigner,
  {
    type = 'payment.succeeded',
    purpose = 'one_off',
    ...facts
  }: PaymentEventFacts,
): { eventId: string; webhook: WebhookRequest } => {
  const eventId = randomUUID();

  return {
    eventId,
    webhook: signer.buildWebhook({
      eventId,
      occurredAt: null,
      events: [
        {
          type,
          purpose,
          providerSubscriptionId: null,
          currency: 'USD',
          failureReason: null,
          ...facts,
        },
      ],
    }),
  };
};

const refundWebhookOf = (
  signer: FakeSigner,
  payment: Pick<Payment, 'id' | 'providerPaymentId'>,
  reference: string | null,
): { eventId: string; webhook: WebhookRequest } => {
  const eventId = randomUUID();

  return {
    eventId,
    webhook: signer.buildWebhook({
      eventId,
      occurredAt: null,
      events: [
        {
          type: 'refund.succeeded',
          providerPaymentId: payment.providerPaymentId,
          reference,
          refundReference: null,
          providerRefundId: randomUUID(),
          amountMinor: 100,
          currency: 'USD',
        },
      ],
    }),
  };
};

describe('provider accounts', () => {
  const two = twoProjects();
  const scoped = scopedReconciliation();
  let app: INestApplication;
  let db: Database;
  let a: TestAccount;
  let b: TestAccount;

  const deliverOn = (
    account: Pick<TestAccount, 'accountId'>,
    webhook: WebhookRequest,
  ) =>
    deliverTo(
      app,
      webhook.rawBody,
      signatureOf(webhook),
      'fake',
      account.accountId,
    );

  const inboxRowsWithKey = (dedupKey: string): Promise<WebhookEvent[]> =>
    db.select().from(webhookEvents).where(eq(webhookEvents.dedupKey, dedupKey));

  const processedRowOf = async (eventId: string): Promise<WebhookEvent> => {
    await tick(app);
    const [row] = await inboxRowsWithKey(eventId);

    return row;
  };

  const insertPayment = async (
    account: Pick<TestAccount, 'projectId' | 'accountId'>,
    overrides: Partial<NewPayment> = {},
  ): Promise<Payment> => {
    const id = randomUUID();
    const amountMinor = uniqueAmountMinor();
    const [payment] = await db
      .insert(payments)
      .values({
        id,
        projectId: account.projectId,
        providerAccountId: account.accountId,
        provider: 'fake',
        providerPaymentId: encodeFakeId({
          reference: id,
          amountMinor,
          currency: 'USD',
        }),
        purpose: 'one_off',
        origin: 'api',
        status: 'pending',
        amountMinor,
        currency: 'USD',
        ...overrides,
      })
      .returning();

    return payment;
  };

  const insertDuePayment = async (account: TestAccount): Promise<Payment> => {
    const payment = await insertPayment(account);
    await db
      .update(payments)
      .set({
        createdAt: sql`clock_timestamp() - ${HOUR_SECONDS}::integer * interval '1 second'`,
        reconcileAfter: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(payments.id, payment.id));
    scoped.paymentIds.add(payment.id);

    return payment;
  };

  const updatedAtTextOf = async (paymentId: string): Promise<string> => {
    const [{ updated_at: updatedAt }] = await db.execute<{
      updated_at: string;
    }>(
      sql`select updated_at::text as updated_at from payments where id = ${paymentId}`,
    );

    return updatedAt;
  };

  const isUntouched = async (
    payment: Payment,
    updatedAtText: string,
  ): Promise<boolean> => {
    const [{ is_untouched: isUntouchedRow }] = await db.execute<{
      is_untouched: boolean;
    }>(sql`
      select (status, updated_at) is not distinct from
        (${payment.status}::text, ${updatedAtText}::timestamptz) as is_untouched
      from payments where id = ${payment.id}
    `);

    return isUntouchedRow;
  };

  const paymentEventCountOf = async (paymentId: string): Promise<number> =>
    (
      await db
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, paymentId))
    ).length;

  const disable = (account: TestAccount) =>
    db
      .update(providerAccounts)
      .set({ status: 'disabled' })
      .where(eq(providerAccounts.id, account.accountId));

  beforeAll(async () => {
    app = await createE2eApp({
      classOverrides: [two.override, scoped.override],
    });
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
  }, SLOW_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    ({ a, b } = await two.create(app));
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    two.failingRefs.clear();
    jest.restoreAllMocks();
  });

  describe('the account webhook route', () => {
    it('stores a delivery signed with the account secret under that account', async () => {
      const payment = await insertPayment(a);
      const { eventId, webhook } = paymentWebhookOf(a.signer, {
        reference: payment.id,
        providerPaymentId: payment.providerPaymentId as string,
        amountMinor: payment.amountMinor,
      });

      await deliverOn(a, webhook).expect(200);

      expect(await inboxRowsWithKey(eventId)).toEqual([
        expect.objectContaining({
          provider: 'fake',
          providerAccountId: a.accountId,
          signatureValid: true,
        }),
      ]);
    });

    it('answers 401 for the secret of another account and stores the invalid row under the URL account', async () => {
      const { webhook } = paymentWebhookOf(b.signer, {
        reference: null,
        providerPaymentId: randomUUID(),
        amountMinor: 1000,
      });

      await deliverOn(a, webhook).expect(401);

      expect(await inboxRowsWithKey(invalidKeyOf(webhook.rawBody))).toEqual([
        expect.objectContaining({
          providerAccountId: a.accountId,
          signatureValid: false,
          status: 'ignored',
        }),
      ]);
    });

    it.each([
      ['a non-uuid', 'not-an-account'],
      ['an unknown account', '0b9d6f0e-5a4b-4c1e-9f3a-eeeeeeeeeeee'],
      ['a Paddle account', SEED_PADDLE_ACCOUNT_ID],
    ])('answers 404 for %s and stores nothing', async (_case, accountId) => {
      const { eventId, webhook } = paymentWebhookOf(a.signer, {
        reference: null,
        providerPaymentId: randomUUID(),
        amountMinor: 1000,
      });

      await deliverOn({ accountId }, webhook).expect(404);

      expect(await inboxRowsWithKey(eventId)).toEqual([]);
      expect(await inboxRowsWithKey(invalidKeyOf(webhook.rawBody))).toEqual([]);
    });

    it('answers 404 on /webhooks/fake, which has no account', async () => {
      const { webhook } = paymentWebhookOf(a.signer, {
        reference: null,
        providerPaymentId: randomUUID(),
        amountMinor: 1000,
      });

      await request(serverOf(app))
        .post('/webhooks/fake')
        .set(FAKE_SIGNATURE_HEADER, signatureOf(webhook))
        .send(webhook.rawBody)
        .expect(404);
    });

    it('caps invalid rows per account, not per provider', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const wrongSignature = 'f'.repeat(64);
      const bodies = Array.from({ length: INVALID_ROWS_CAP + 1 }, () =>
        Buffer.from(randomUUID()),
      );

      for (const rawBody of bodies) {
        await deliverTo(
          app,
          rawBody,
          wrongSignature,
          'fake',
          a.accountId,
        ).expect(401);
      }
      const otherBody = Buffer.from(randomUUID());
      await deliverTo(
        app,
        otherBody,
        wrongSignature,
        'fake',
        b.accountId,
      ).expect(401);

      const storedForA = await db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(eq(webhookEvents.providerAccountId, a.accountId));
      expect(storedForA).toHaveLength(INVALID_ROWS_CAP);
      expect(await inboxRowsWithKey(invalidKeyOf(otherBody))).toHaveLength(1);
    });
  });

  describe('events for another account', () => {
    it('ignores an event that names the payment of another account in one attempt', async () => {
      const paymentOfB = await insertPayment(b);
      const updatedAtText = await updatedAtTextOf(paymentOfB.id);
      const { eventId, webhook } = paymentWebhookOf(a.signer, {
        reference: paymentOfB.id,
        providerPaymentId: randomUUID(),
        amountMinor: paymentOfB.amountMinor,
      });

      await deliverOn(a, webhook).expect(200);
      const row = await processedRowOf(eventId);

      expect(row).toMatchObject({ status: 'ignored', attempts: 1 });
      expect(row.lastError).toContain('belongs to another account');
      expect(await isUntouched(paymentOfB, updatedAtText)).toBe(true);
      expect(await paymentEventCountOf(paymentOfB.id)).toBe(0);
    });

    it('ignores an event that only has the provider id of another account in one attempt', async () => {
      const paymentOfB = await insertPayment(b);
      const updatedAtText = await updatedAtTextOf(paymentOfB.id);
      const { eventId, webhook } = paymentWebhookOf(a.signer, {
        reference: null,
        providerPaymentId: paymentOfB.providerPaymentId as string,
        amountMinor: paymentOfB.amountMinor,
      });

      await deliverOn(a, webhook).expect(200);
      const row = await processedRowOf(eventId);

      expect(row).toMatchObject({ status: 'ignored', attempts: 1 });
      expect(row.lastError).toContain('belongs to another account');
      expect(await isUntouched(paymentOfB, updatedAtText)).toBe(true);
    });

    it('keeps retrying a provider id that exists nowhere', async () => {
      const { eventId, webhook } = paymentWebhookOf(a.signer, {
        reference: null,
        providerPaymentId: randomUUID(),
        amountMinor: 1000,
      });

      await deliverOn(a, webhook).expect(200);
      const row = await processedRowOf(eventId);

      expect(row).toMatchObject({ status: 'received', attempts: 1 });
    });

    it.each([
      ['by reference', true],
      ['by provider id', false],
    ])(
      'ignores a refund event for the payment of another account %s',
      async (_case, isByReference) => {
        const paymentOfB = await insertPayment(b, { status: 'succeeded' });
        const { eventId, webhook } = refundWebhookOf(
          a.signer,
          paymentOfB,
          isByReference ? paymentOfB.id : null,
        );

        await deliverOn(a, webhook).expect(200);
        const row = await processedRowOf(eventId);

        expect(row).toMatchObject({ status: 'ignored', attempts: 1 });
        expect(
          await db
            .select()
            .from(refunds)
            .where(eq(refunds.paymentId, paymentOfB.id)),
        ).toEqual([]);
      },
    );

    it('births a renewal under the project and account of the URL', async () => {
      const providerPaymentId = randomUUID();
      const { eventId, webhook } = paymentWebhookOf(b.signer, {
        purpose: 'subscription_renewal',
        reference: null,
        providerPaymentId,
        amountMinor: 1000,
      });

      await deliverOn(b, webhook).expect(200);
      const row = await processedRowOf(eventId);

      expect(row.status).toBe('processed');
      expect(
        await db
          .select({
            projectId: payments.projectId,
            providerAccountId: payments.providerAccountId,
          })
          .from(payments)
          .where(eq(payments.providerPaymentId, providerPaymentId)),
      ).toEqual([{ projectId: b.projectId, providerAccountId: b.accountId }]);
    });
  });

  describe('a disabled account', () => {
    // Only this app reads the seed account as disabled: other spec files create fake payments on it in parallel.
    const readSeedFakeAccountAsDisabled = (): void => {
      const repository = app.get(ProviderAccountsRepository);
      const findById = repository.findById.bind(repository);
      const findByProjectAndProvider =
        repository.findByProjectAndProvider.bind(repository);
      const asDisabled = (account: StoredAccount | null) =>
        account?.id === SEED_FAKE_ACCOUNT_ID
          ? { ...account, status: 'disabled' as const }
          : account;

      jest
        .spyOn(repository, 'findById')
        .mockImplementation(async (accountId) =>
          asDisabled(await findById(accountId)),
        );
      jest
        .spyOn(repository, 'findByProjectAndProvider')
        .mockImplementation(async (projectId, provider) =>
          asDisabled(await findByProjectAndProvider(projectId, provider)),
        );
    };

    it('refunds a payment of the seed account through the API while refusing it new payments', async () => {
      const payment = await insertPayment(
        { projectId: SEED_PROJECT_ID, accountId: SEED_FAKE_ACCOUNT_ID },
        { status: 'succeeded' },
      );
      readSeedFakeAccountAsDisabled();

      const newPayment = await request(serverOf(app))
        .post(PAYMENTS_PATH)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          provider: 'fake',
          amountMinor: 1000,
          currency: 'USD',
          description: 'disabled account check',
          returnUrl: 'https://shop.example.test/return',
        })
        .expect(422);
      const refund = await request(serverOf(app))
        .post(`${PAYMENTS_PATH}/${payment.id}/refunds`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: 100 })
        .expect(201);

      expect(newPayment.body).toMatchObject({ code: 'provider_not_available' });
      expect(refund.body).toMatchObject({
        paymentId: payment.id,
        status: 'succeeded',
      });
      expect(
        await db
          .select({ providerAccountId: refunds.providerAccountId })
          .from(refunds)
          .where(eq(refunds.paymentId, payment.id)),
      ).toEqual([{ providerAccountId: SEED_FAKE_ACCOUNT_ID }]);
    });

    it('still takes its webhooks and its reconciliation', async () => {
      const pendingPayment = await insertPayment(b);
      const duePayment = await insertDuePayment(b);
      await disable(b);
      const { eventId, webhook } = paymentWebhookOf(b.signer, {
        reference: pendingPayment.id,
        providerPaymentId: pendingPayment.providerPaymentId as string,
        amountMinor: pendingPayment.amountMinor,
      });

      await deliverOn(b, webhook).expect(200);
      expect((await processedRowOf(eventId)).status).toBe('processed');

      await app.get(ReconciliationWorker).drain();
      const [reconciled] = await db
        .select({
          status: payments.status,
          reconcileAttempts: payments.reconcileAttempts,
        })
        .from(payments)
        .where(eq(payments.id, duePayment.id));
      expect(reconciled).toEqual({ status: 'succeeded', reconcileAttempts: 1 });
    });
  });

  describe('reconciliation', () => {
    it('skips only the account whose credentials fail, binding it once per cycle', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      two.failingRefs.add(FAKE_A_CREDENTIALS_REF);
      const bind = jest.spyOn(ProviderAccountsService.prototype, 'bind');
      const dueOnA = [await insertDuePayment(a), await insertDuePayment(a)];
      const dueOnB = await insertDuePayment(b);

      await app.get(ReconciliationWorker).drain();

      expect(
        bind.mock.calls.filter(([accountId]) => accountId === a.accountId),
      ).toHaveLength(1);
      const [reconciledOnB] = await db
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, dueOnB.id));
      expect(reconciledOnB.status).toBe('succeeded');
      const [{ due_count: dueCount }] = await db.execute<{
        due_count: number;
      }>(sql`
        select count(*)::int as due_count from payments
        where id in (${dueOnA[0].id}, ${dueOnA[1].id}) and reconcile_after <= now()
      `);
      expect(dueCount).toBe(1);
    });
  });

  describe('payment creation', () => {
    const createPayment = (key: string) =>
      request(serverOf(app))
        .post(PAYMENTS_PATH)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .set('Idempotency-Key', key)
        .send({
          provider: 'fake',
          amountMinor: 1000,
          currency: 'USD',
          description: 'account check',
          returnUrl: 'https://shop.example.test/return',
        });

    it('replays a finished request after its account stopped taking payments, and refuses a new one', async () => {
      const key = randomUUID();
      const first = await createPayment(key).expect(201);
      jest
        .spyOn(ProviderAccountsService.prototype, 'bindForNewPayment')
        .mockResolvedValue(null);

      const replay = await createPayment(key).expect(201);
      const refused = await createPayment(randomUUID()).expect(422);

      expect(replay.body).toEqual(first.body);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(refused.body).toMatchObject({ code: 'provider_not_available' });
    });

    it('records an API payment under the seed project and fake account', async () => {
      const response = await createPayment(randomUUID()).expect(201);

      const [payment] = await db
        .select({
          projectId: payments.projectId,
          providerAccountId: payments.providerAccountId,
        })
        .from(payments)
        .where(
          eq(payments.id, (response.body as { paymentId: string }).paymentId),
        );
      expect(payment).toEqual({
        projectId: SEED_PROJECT_ID,
        providerAccountId: SEED_FAKE_ACCOUNT_ID,
      });
    });
  });
});
