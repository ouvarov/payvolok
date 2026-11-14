import { randomInt } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type Database } from '@/database/drizzle';
import { payments } from '@/database/schemas/payments.schema';
import { refunds } from '@/database/schemas/refunds.schema';
import { webhookEvents } from '@/database/schemas/webhook-events.schema';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import { SEED_FAKE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';
import { FakeProvider } from '@/providers/fake/fake.provider';
import { WebhooksService } from '@/webhooks/webhooks.service';

import { createE2eApp } from './helpers';
import {
  createApiPayment,
  createApiRefund,
  deliverWebhook,
  originalRowsOf,
  tick,
} from './webhook-replay';

const REFUND_AMOUNT_MINOR = 1000;

const SEED_FAKE_COLUMNS = {
  projectId: SEED_PROJECT_ID,
  providerAccountId: SEED_FAKE_ACCOUNT_ID,
};

const uniqueAmountMinor = (): number => randomInt(10_000, 10_000_000) * 100;

describe('project and account columns of API rows', () => {
  let app: INestApplication;
  let db: Database;

  beforeAll(async () => {
    app = await createE2eApp();
    db = app.get<Database>(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes the seed project and the seed fake account on a payment, its webhooks, its refund and a replay', async () => {
    const { paymentId, providerPaymentId } = await createApiPayment(
      app,
      uniqueAmountMinor(),
    );
    const webhooks = app
      .get(FakeProvider)
      .buildPaymentWebhooks(providerPaymentId, new Date());
    for (const webhook of webhooks) {
      expect(await deliverWebhook(app, webhook)).toBe(200);
    }
    await tick(app);

    const [payment] = await db
      .select({
        status: payments.status,
        projectId: payments.projectId,
        providerAccountId: payments.providerAccountId,
      })
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(payment).toEqual({ status: 'succeeded', ...SEED_FAKE_COLUMNS });

    const originals = await originalRowsOf(app, webhooks);
    expect(originals).toHaveLength(webhooks.length);
    for (const row of originals) {
      expect(row.providerAccountId).toBe(SEED_FAKE_ACCOUNT_ID);
    }

    const { refundId } = await createApiRefund(
      app,
      paymentId,
      REFUND_AMOUNT_MINOR,
    );
    const [refund] = await db
      .select({
        projectId: refunds.projectId,
        providerAccountId: refunds.providerAccountId,
      })
      .from(refunds)
      .where(eq(refunds.id, refundId));
    expect(refund).toEqual(SEED_FAKE_COLUMNS);

    const replayId = await app.get(WebhooksService).replay(originals[0].id);
    const [replay] = await db
      .select({
        replayOf: webhookEvents.replayOf,
        providerAccountId: webhookEvents.providerAccountId,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, replayId as string));
    expect(replay).toEqual({
      replayOf: originals[0].id,
      providerAccountId: SEED_FAKE_ACCOUNT_ID,
    });
    await tick(app);
  });
});
