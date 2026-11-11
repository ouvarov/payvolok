import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type Payment,
  type PaymentEvent,
} from '@/database/schemas/payments.schema';
import { refunds, type Refund } from '@/database/schemas/refunds.schema';
import {
  webhookEvents,
  type WebhookEvent,
} from '@/database/schemas/webhook-events.schema';
import type {
  PaymentOrigin,
  PaymentStatus,
} from '@/payments/payment.constants';
import { FakeProvider } from '@/providers/fake/fake.provider';
import type { WebhookRequest } from '@/providers/payment-provider.port';
import type { RefundStatus } from '@/refunds/refund.constants';
import { MAX_ATTEMPTS } from '@/webhooks/webhook-event.processor';
import { WebhookWorker } from '@/webhooks/webhook.worker';

import {
  deliverTo,
  FAKE_SIGNATURE_HEADER,
  serverOf,
  TEST_API_KEY,
} from './helpers';

const DEFAULT_REPLAY_SEED = 20260611;
const SEED_MIX_INCREMENT = 0x6d2b79f5;
const UINT32_RANGE = 2 ** 32;
const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const RETURN_URL = 'https://example.test/return';

const REPLAY_SEED = Number(process.env.REPLAY_SEED ?? DEFAULT_REPLAY_SEED);

type DeliveryOptions = {
  isTickedEach: boolean;
  beforeDelivery?: (
    position: number,
    webhookIndex: number,
  ) => void | Promise<void>;
};

type DeliveryLog = {
  statuses: number[];
  tickErrors: (string | null)[];
};

type MoneyState = {
  payment: Payment;
  paymentsWithProviderRef: number;
  events: PaymentEvent[];
  refunds: Refund[];
};

type ExpectedRefund = {
  origin: PaymentOrigin;
  status: RefundStatus;
  amountMinor: number;
  providerRefundId: string;
};

type ExpectedEnd = {
  amountMinor: number;
  providerPaymentId: string;
  finalStatus: PaymentStatus;
  path: PaymentStatus[];
  apiPath: PaymentStatus[];
  eventCount: number;
  refunds: ExpectedRefund[];
  succeededMinor: number;
  statuses: number[];
  attemptsOf?: Record<string, number>;
};

type SettledRows = {
  originals: WebhookEvent[];
  replays: WebhookEvent[];
  statuses: number[];
};

const databaseOf = (app: INestApplication): Database =>
  app.get<Database>(DRIZZLE);

const factorialOf = (count: number): number =>
  count <= 1 ? 1 : count * factorialOf(count - 1);

const identityOrderOf = (count: number): number[] =>
  Array.from({ length: count }, (_value, index) => index);

const permutationsOf = (count: number): number[][] => {
  const build = (remaining: number[]): number[][] =>
    remaining.length === 0
      ? [[]]
      : remaining.flatMap((item) =>
          build(remaining.filter((other) => other !== item)).map((rest) => [
            item,
            ...rest,
          ]),
        );

  return build(identityOrderOf(count));
};

// mulberry32: tiny, deterministic and good enough to pick test orders.
const randomFromSeed = (seed: number): (() => number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + SEED_MIX_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
};

const shuffled = (items: number[], random: () => number): number[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
};

const orderLabel = (order: number[]): string => order.join('-');

const sampledOrdersOf = (
  count: number,
  size: number,
  seed: number,
): number[][] => {
  const identity = identityOrderOf(count);
  const reverse = [...identity].reverse();
  if (size > factorialOf(count) - 2) {
    throw new Error(`Cannot sample ${size} orders of ${count} events`);
  }

  const random = randomFromSeed(seed);
  const seenLabels = new Set([orderLabel(identity), orderLabel(reverse)]);
  const sample: number[][] = [];
  while (sample.length < size) {
    const order = shuffled(identity, random);
    if (seenLabels.has(orderLabel(order))) continue;

    seenLabels.add(orderLabel(order));
    sample.push(order);
  }

  return sample;
};

const authorizedPost = (app: INestApplication, path: string) =>
  request(serverOf(app))
    .post(path)
    .set('Authorization', `Bearer ${TEST_API_KEY}`)
    .set('Idempotency-Key', `replay-${randomUUID()}`);

const createApiPayment = async (
  app: INestApplication,
  amountMinor: number,
): Promise<{ paymentId: string; providerPaymentId: string }> => {
  const response = await authorizedPost(app, PAYMENTS_PATH)
    .send({
      provider: 'fake',
      amountMinor,
      currency: 'USD',
      description: 'replay harness',
      returnUrl: RETURN_URL,
    })
    .expect(201);
  const paymentId = (response.body as { paymentId: string }).paymentId;
  const [payment] = await databaseOf(app)
    .select({ providerPaymentId: payments.providerPaymentId })
    .from(payments)
    .where(eq(payments.id, paymentId));

  return { paymentId, providerPaymentId: payment.providerPaymentId as string };
};

const createApiRefund = async (
  app: INestApplication,
  paymentId: string,
  amountMinor: number,
): Promise<{ refundId: string }> => {
  const response = await authorizedPost(
    app,
    `${PAYMENTS_PATH}/${paymentId}/refunds`,
  )
    .send({ amountMinor })
    .expect(201);

  return { refundId: (response.body as { refundId: string }).refundId };
};

const deliverWebhook = async (
  app: INestApplication,
  webhook: WebhookRequest,
): Promise<number> => {
  const response = await deliverTo(
    app,
    webhook.rawBody,
    webhook.headers[FAKE_SIGNATURE_HEADER] as string,
  );

  return response.status;
};

const tick = (app: INestApplication): Promise<number> =>
  app.get(WebhookWorker).drain();

const tickOrError = async (app: INestApplication): Promise<string | null> => {
  try {
    await tick(app);

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const deliverInOrder = async (
  app: INestApplication,
  webhooks: WebhookRequest[],
  order: number[],
  { isTickedEach, beforeDelivery }: DeliveryOptions,
): Promise<DeliveryLog> => {
  const log: DeliveryLog = { statuses: [], tickErrors: [] };

  for (const [position, webhookIndex] of order.entries()) {
    await beforeDelivery?.(position, webhookIndex);
    log.statuses.push(await deliverWebhook(app, webhooks[webhookIndex]));
    log.tickErrors.push(isTickedEach ? await tickOrError(app) : null);
  }

  return log;
};

const dedupKeysOf = (
  app: INestApplication,
  webhooks: WebhookRequest[],
): string[] =>
  webhooks.map(
    (webhook) => app.get(FakeProvider).parseWebhook(webhook)[0].dedupKey,
  );

const originalRowsOf = (
  app: INestApplication,
  webhooks: WebhookRequest[],
): Promise<WebhookEvent[]> =>
  databaseOf(app)
    .select()
    .from(webhookEvents)
    .where(
      and(
        inArray(webhookEvents.dedupKey, dedupKeysOf(app, webhooks)),
        isNull(webhookEvents.replayOf),
      ),
    )
    .orderBy(asc(webhookEvents.createdAt), asc(webhookEvents.id));

const replayRowsOf = (
  app: INestApplication,
  originalIds: string[],
): Promise<WebhookEvent[]> =>
  databaseOf(app)
    .select()
    .from(webhookEvents)
    .where(inArray(webhookEvents.replayOf, originalIds))
    .orderBy(asc(webhookEvents.createdAt), asc(webhookEvents.id));

const settle = async (
  app: INestApplication,
  rowIds: string[],
): Promise<void> => {
  const db = databaseOf(app);

  for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
    const dueRows = await db
      .update(webhookEvents)
      .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
      .where(
        and(
          inArray(webhookEvents.id, rowIds),
          eq(webhookEvents.status, 'received'),
        ),
      )
      .returning({ id: webhookEvents.id });
    if (dueRows.length === 0) return;

    await tick(app);
  }
};

const moneyStateOf = async (
  db: Database,
  paymentId: string,
): Promise<MoneyState> => {
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId));
  const paymentsWithProviderRef = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.provider, payment.provider),
        eq(payments.providerPaymentId, payment.providerPaymentId as string),
      ),
    );

  return {
    payment,
    paymentsWithProviderRef: paymentsWithProviderRef.length,
    events: await db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, paymentId))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id)),
    refunds: await db
      .select()
      .from(refunds)
      .where(eq(refunds.paymentId, paymentId)),
  };
};

const byAmountMinor = (
  left: { amountMinor: number },
  right: { amountMinor: number },
): number => left.amountMinor - right.amountMinor;

const expectPaymentRow = (
  { payment, paymentsWithProviderRef }: MoneyState,
  expected: ExpectedEnd,
): void => {
  expect(paymentsWithProviderRef).toBe(1);
  expect(payment).toMatchObject({
    amountMinor: expected.amountMinor,
    currency: 'USD',
    providerPaymentId: expected.providerPaymentId,
  });
};

const expectStatusPath = (
  { payment, events }: MoneyState,
  expected: ExpectedEnd,
): void => {
  const appliedEvents = events.filter(({ outcome }) => outcome === 'applied');

  expect(payment.status).toBe(expected.finalStatus);
  expect(appliedEvents.map(({ toStatus }) => toStatus)).toEqual(expected.path);
  expect(appliedEvents.map(({ fromStatus }) => fromStatus)).toEqual([
    null,
    ...expected.path.slice(0, -1),
  ]);
};

const expectEventLinks = (
  { events }: MoneyState,
  runRowIds: string[],
  expected: ExpectedEnd,
): void => {
  const appliedEvents = events.filter(({ outcome }) => outcome === 'applied');
  const linkedIdsOf = (linkedEvents: typeof events): string[] =>
    linkedEvents.flatMap(({ webhookEventId }) =>
      webhookEventId === null ? [] : [webhookEventId],
    );

  expect(
    events
      .filter(({ webhookEventId }) => webhookEventId === null)
      .map(({ toStatus }) => toStatus),
  ).toEqual(expected.apiPath);
  for (const linkedId of linkedIdsOf(events)) {
    expect(runRowIds).toContain(linkedId);
  }
  const appliedLinkedIds = linkedIdsOf(appliedEvents);
  expect(new Set(appliedLinkedIds).size).toBe(appliedLinkedIds.length);
};

const expectRefunds = (
  { refunds: refundRows }: MoneyState,
  expected: ExpectedEnd,
): void => {
  expect(
    [...refundRows]
      .sort(byAmountMinor)
      .map(({ origin, status, amountMinor, providerRefundId }) => ({
        origin,
        status,
        amountMinor,
        providerRefundId,
      })),
  ).toEqual([...expected.refunds].sort(byAmountMinor));
  expect(
    refundRows
      .filter(({ status }) => status === 'succeeded')
      .reduce((sum, { amountMinor }) => sum + amountMinor, 0),
  ).toBe(expected.succeededMinor);
};

const expectInboxRows = (
  { payment }: MoneyState,
  { originals, replays }: SettledRows,
  expected: ExpectedEnd,
): void => {
  expect(originals).toHaveLength(expected.eventCount);
  for (const row of originals) {
    expect(row).toMatchObject({
      status: 'processed',
      lastError: null,
      paymentIds: [payment.id],
      attempts: expected.attemptsOf?.[row.id] ?? 1,
    });
  }
  for (const row of replays) {
    expect(row).toMatchObject({
      status: 'processed',
      lastError: null,
      paymentIds: [payment.id],
      rawBody: null,
    });
    expect(originals.map(({ id }) => id)).toContain(row.replayOf);
  }
};

const expectSettled = (
  state: MoneyState,
  rows: SettledRows,
  expected: ExpectedEnd,
): void => {
  const runRowIds = [...rows.originals, ...rows.replays].map(({ id }) => id);

  expectPaymentRow(state, expected);
  expectStatusPath(state, expected);
  expectEventLinks(state, runRowIds, expected);
  expectRefunds(state, expected);
  expectInboxRows(state, rows, expected);
  expect(rows.statuses).toEqual(expected.statuses);
};

export {
  createApiPayment,
  createApiRefund,
  deliverInOrder,
  deliverWebhook,
  expectSettled,
  identityOrderOf,
  moneyStateOf,
  orderLabel,
  originalRowsOf,
  permutationsOf,
  REPLAY_SEED,
  replayRowsOf,
  sampledOrdersOf,
  settle,
  tick,
};
export type { DeliveryLog, ExpectedEnd, ExpectedRefund, MoneyState };
