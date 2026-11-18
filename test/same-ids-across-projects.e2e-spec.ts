import { randomInt, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import { payments, type Payment } from '@/database/schemas/payments.schema';
import { projects } from '@/database/schemas/projects.schema';
import { webhookEvents } from '@/database/schemas/webhook-events.schema';
import type { WebhookRequest } from '@/providers/payment-provider.port';

import {
  createE2eApp,
  deliverTo,
  FAKE_SIGNATURE_HEADER,
  serverOf,
} from './helpers';
import { twoProjects, type TestAccount } from './two-projects';
import { tick } from './webhook-replay';

const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const SHOP_ORIGIN = 'https://shop.example';
const SHARED_IDEMPOTENCY_KEY = 'order-1';
const SLOW_TEST_TIMEOUT_MS = 60000;

const uniqueAmountMinor = (): number => randomInt(10_000, 10_000_000) * 100;

type SucceededEvent = {
  eventId: string;
  reference: string | null;
  providerPaymentId: string;
  amountMinor: number;
};

const succeededWebhookOf = (
  account: TestAccount,
  { eventId, ...facts }: SucceededEvent,
): WebhookRequest =>
  account.signer.buildWebhook({
    eventId,
    occurredAt: null,
    events: [
      {
        type: 'payment.succeeded',
        purpose: 'one_off',
        providerSubscriptionId: null,
        currency: 'USD',
        failureReason: null,
        ...facts,
      },
    ],
  });

describe('the same ids in two projects', () => {
  const two = twoProjects();
  let app: INestApplication;
  let db: Database;
  let a: TestAccount;
  let b: TestAccount;

  const deliverOn = (account: TestAccount, webhook: WebhookRequest) =>
    deliverTo(
      app,
      webhook.rawBody,
      webhook.headers[FAKE_SIGNATURE_HEADER] as string,
      'fake',
      account.accountId,
    );

  const insertPendingPayment = async (
    account: TestAccount,
    providerPaymentId: string,
  ): Promise<Payment> => {
    const [payment] = await db
      .insert(payments)
      .values({
        projectId: account.projectId,
        providerAccountId: account.accountId,
        provider: 'fake',
        providerPaymentId,
        purpose: 'one_off',
        origin: 'api',
        status: 'pending',
        amountMinor: uniqueAmountMinor(),
        currency: 'USD',
      })
      .returning();

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
    paymentId: string,
    updatedAtText: string,
  ): Promise<boolean> => {
    const [{ is_untouched: isUntouchedRow }] = await db.execute<{
      is_untouched: boolean;
    }>(sql`
      select (status, updated_at) is not distinct from
        ('pending'::text, ${updatedAtText}::timestamptz) as is_untouched
      from payments where id = ${paymentId}
    `);

    return isUntouchedRow;
  };

  const statusOf = async (paymentId: string): Promise<string> => {
    const [{ status }] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.id, paymentId));

    return status;
  };

  const postPayment = (account: TestAccount, body: object) =>
    request(serverOf(app))
      .post(PAYMENTS_PATH)
      .set('Authorization', `Bearer ${account.apiKey}`)
      .set('Idempotency-Key', SHARED_IDEMPOTENCY_KEY)
      .send(body);

  beforeAll(async () => {
    app = await createE2eApp({ classOverrides: [two.override] });
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
    ({ a, b } = await two.create(app));
    await db
      .update(projects)
      .set({ allowedReturnOrigins: [SHOP_ORIGIN] })
      .where(inArray(projects.id, [a.projectId, b.projectId]));
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  it('keeps two payments with one provider_payment_id, each moved only by its own account', async () => {
    const providerPaymentId = randomUUID();
    const paymentOfA = await insertPendingPayment(a, providerPaymentId);
    const paymentOfB = await insertPendingPayment(b, providerPaymentId);
    const updatedAtOfB = await updatedAtTextOf(paymentOfB.id);

    await deliverOn(
      a,
      succeededWebhookOf(a, {
        eventId: randomUUID(),
        reference: null,
        providerPaymentId,
        amountMinor: paymentOfA.amountMinor,
      }),
    ).expect(200);
    await tick(app);

    expect(await statusOf(paymentOfA.id)).toBe('succeeded');
    expect(await isUntouched(paymentOfB.id, updatedAtOfB)).toBe(true);

    await deliverOn(
      b,
      succeededWebhookOf(b, {
        eventId: randomUUID(),
        reference: null,
        providerPaymentId,
        amountMinor: paymentOfB.amountMinor,
      }),
    ).expect(200);
    await tick(app);

    expect(await statusOf(paymentOfB.id)).toBe('succeeded');
  });

  it('processes one dedup key delivered to two accounts as two rows', async () => {
    const eventId = randomUUID();
    const paymentOfA = await insertPendingPayment(a, randomUUID());
    const paymentOfB = await insertPendingPayment(b, randomUUID());

    for (const [account, payment] of [
      [a, paymentOfA],
      [b, paymentOfB],
    ] as const) {
      await deliverOn(
        account,
        succeededWebhookOf(account, {
          eventId,
          reference: payment.id,
          providerPaymentId: payment.providerPaymentId as string,
          amountMinor: payment.amountMinor,
        }),
      ).expect(200);
    }
    await tick(app);

    expect(
      await db
        .select({
          providerAccountId: webhookEvents.providerAccountId,
          status: webhookEvents.status,
        })
        .from(webhookEvents)
        .where(eq(webhookEvents.dedupKey, eventId))
        .orderBy(webhookEvents.createdAt),
    ).toEqual([
      { providerAccountId: a.accountId, status: 'processed' },
      { providerAccountId: b.accountId, status: 'processed' },
    ]);
    expect(await statusOf(paymentOfA.id)).toBe('succeeded');
    expect(await statusOf(paymentOfB.id)).toBe('succeeded');
  });

  it('gives Idempotency-Key order-1 its own payment in each project and replays each', async () => {
    const body = {
      provider: 'fake',
      amountMinor: uniqueAmountMinor(),
      currency: 'USD',
      description: 'same key in two projects',
      returnUrl: `${SHOP_ORIGIN}/return`,
    };

    const firstOfA = await postPayment(a, body).expect(201);
    const firstOfB = await postPayment(b, body).expect(201);
    const replayOfA = await postPayment(a, body).expect(201);
    const replayOfB = await postPayment(b, body).expect(201);

    const paymentIdOf = (response: request.Response): string =>
      (response.body as { paymentId: string }).paymentId;
    expect(paymentIdOf(firstOfA)).not.toBe(paymentIdOf(firstOfB));
    expect(replayOfA.text).toBe(firstOfA.text);
    expect(replayOfB.text).toBe(firstOfB.text);
    expect(replayOfA.headers['idempotent-replayed']).toBe('true');
    expect(replayOfB.headers['idempotent-replayed']).toBe('true');
    expect(
      await db
        .select({ projectId: payments.projectId })
        .from(payments)
        .where(
          inArray(payments.id, [paymentIdOf(firstOfA), paymentIdOf(firstOfB)]),
        )
        .orderBy(payments.projectId),
    ).toEqual(
      [a.projectId, b.projectId].sort().map((projectId) => ({ projectId })),
    );
  });
});
