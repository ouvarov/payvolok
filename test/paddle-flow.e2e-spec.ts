import { createHash, randomInt } from 'node:crypto';

import { Logger, type INestApplication } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import { payments, type Payment } from '@/database/schemas/payments.schema';
import { refunds, type Refund } from '@/database/schemas/refunds.schema';
import {
  webhookEvents,
  type WebhookEvent,
} from '@/database/schemas/webhook-events.schema';
import {
  adjustmentEventFixture,
  adjustmentResponseFixture,
  PADDLE_SIGNATURE_HEADER,
  signedPaddleWebhook,
  syntheticPaddleId,
  transactionEventFixture,
  transactionResponseFixture,
} from '@/providers/paddle/fixtures/paddle-fixtures';
import { PaddleProvider } from '@/providers/paddle/paddle.provider';

import { createE2eApp, serverOf, TEST_API_KEY } from './helpers';
import { tick } from './webhook-replay';

type FetchHandler = (init: RequestInit | undefined) => Promise<Response>;

type CreatedPaddlePayment = {
  paymentId: string;
  transactionId: string;
  checkoutUrl: string;
};

const API_KEY = `pdl_sdbx_apikey_${'e2e0'.repeat(13)}`;
const WEBHOOK_SECRET = 'pdl_ntfset_01jce2esecret000000000000001_E2eSecret';
const CLIENT_TOKEN = 'test_E2eClientToken0123456789abc';
const FIXED_NOW_MS = 1_762_855_200_000;
const PADDLE_API = 'https://sandbox-api.paddle.com';
const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const CHECKOUT_PAGE_BASE = 'https://payvolok.e2e.test/checkout/paddle';
const SLOW_TEST_TIMEOUT_MS = 60000;
const PROCESS_DEADLINE_MS = 15000;
const PROCESS_POLL_MS = 100;

const uniqueAmountMinor = (): number => randomInt(10_000, 10_000_000) * 100;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const requestBodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

const referenceOf = (init: RequestInit | undefined): string =>
  (requestBodyOf(init) as { custom_data: { reference: string } }).custom_data
    .reference;

const sendBytesAsTheyAre = (rawBody: unknown): string => rawBody as string;

const invalidKeyOf = (rawBody: Buffer): string =>
  `invalid:${createHash('sha256').update(rawBody).digest('hex')}`;

const completedEventFor = (
  transactionId: string,
  reference: string,
  totalMinor: number,
) => {
  const event = transactionEventFixture('event-transaction-completed');
  event.event_id = syntheticPaddleId('evt');
  event.data.id = transactionId;
  event.data.custom_data = { reference };
  event.data.details.totals.total = String(totalMinor);
  event.data.details.totals.grand_total = String(totalMinor);

  return event;
};

const adjustmentEventFor = (
  name: 'event-adjustment-created' | 'event-adjustment-updated-approved',
  adjustmentId: string,
  transactionId: string,
  totalMinor: number,
) => {
  const event = adjustmentEventFixture(name);
  event.event_id = syntheticPaddleId('evt');
  event.data.id = adjustmentId;
  event.data.transaction_id = transactionId;
  event.data.totals.total = String(totalMinor);

  return event;
};

describe('Paddle provider', () => {
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

  const deliver = (
    target: INestApplication,
    rawBody: Buffer,
    signature?: string,
  ) => {
    const delivery = request(serverOf(target))
      .post('/webhooks/paddle')
      .set('Content-Type', 'application/json');
    if (signature !== undefined) {
      delivery.set(PADDLE_SIGNATURE_HEADER, signature);
    }

    return delivery.serialize(sendBytesAsTheyAre).send(rawBody);
  };

  const deliverSigned = (body: unknown) => {
    const webhook = signedPaddleWebhook(body, WEBHOOK_SECRET, FIXED_NOW_MS);

    return deliver(
      app,
      webhook.rawBody,
      webhook.headers[PADDLE_SIGNATURE_HEADER] as string,
    );
  };

  // Another spec file's drain may claim the row first, so wait for its outcome.
  const deliverAndProcess = async (event: {
    event_id: string;
  }): Promise<void> => {
    await deliverSigned(event).expect(200);
    const deadline = Date.now() + PROCESS_DEADLINE_MS;

    for (;;) {
      await tick(app);
      const [row] = await inboxRowsWithKey(event.event_id);
      if (row && row.status !== 'received') return;
      if (Date.now() > deadline) {
        throw new Error(`Inbox row ${event.event_id} was not processed`);
      }
      await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
    }
  };

  const authorizedPost = (path: string) =>
    request(serverOf(app))
      .post(path)
      .set('Authorization', `Bearer ${TEST_API_KEY}`)
      .set('Idempotency-Key', `paddle-${syntheticPaddleId('key')}`);

  const stubCreatedTransaction = (
    amountMinor: number,
    beforeAnswer: (
      reference: string,
      transactionId: string,
    ) => Promise<void> = () => Promise.resolve(),
  ): string => {
    const transactionId = syntheticPaddleId('txn');
    fetchHandlers.set(`POST ${PADDLE_API}/transactions`, async (init) => {
      const reference = referenceOf(init);
      await beforeAnswer(reference, transactionId);

      const fixture = transactionResponseFixture('transaction-created');
      fixture.data.id = transactionId;
      fixture.data.custom_data = { reference };
      fixture.data.details.totals.total = String(amountMinor);
      fixture.data.details.totals.grand_total = String(amountMinor);
      fixture.data.checkout = {
        url: `${CHECKOUT_PAGE_BASE}?_ptxn=${transactionId}`,
      };

      return jsonResponse(fixture, 201);
    });

    return transactionId;
  };

  const createPaddlePayment = async (
    amountMinor: number,
    beforeAnswer?: (reference: string, transactionId: string) => Promise<void>,
  ): Promise<CreatedPaddlePayment> => {
    const transactionId = stubCreatedTransaction(amountMinor, beforeAnswer);
    const response = await authorizedPost(PAYMENTS_PATH)
      .send({
        provider: 'paddle',
        amountMinor,
        currency: 'USD',
        description: 'e2e paddle order',
        returnUrl: 'https://shop.example.test/return',
      })
      .expect(201);
    const body = response.body as {
      paymentId: string;
      checkout: { url: string };
    };

    return {
      paymentId: body.paymentId,
      transactionId,
      checkoutUrl: body.checkout.url,
    };
  };

  const succeededPayment = async (
    amountMinor: number,
  ): Promise<CreatedPaddlePayment> => {
    const payment = await createPaddlePayment(amountMinor);
    await deliverAndProcess(
      completedEventFor(payment.transactionId, payment.paymentId, amountMinor),
    );

    return payment;
  };

  const stubRefund = (
    transactionId: string,
    amountMinor: number,
    beforeAnswer: (adjustmentId: string) => Promise<void> = () =>
      Promise.resolve(),
  ): string => {
    const adjustmentId = syntheticPaddleId('adj');
    const transaction = transactionResponseFixture('transaction-completed');
    transaction.data.id = transactionId;
    transaction.data.details.totals.total = String(amountMinor);
    transaction.data.details.totals.grand_total = String(amountMinor);
    fetchHandlers.set(`GET ${PADDLE_API}/transactions/${transactionId}`, () =>
      Promise.resolve(jsonResponse(transaction)),
    );
    fetchHandlers.set(`POST ${PADDLE_API}/adjustments`, async (init) => {
      const { items } = requestBodyOf(init) as {
        items: { amount: string }[];
      };
      await beforeAnswer(adjustmentId);

      const adjustment = adjustmentResponseFixture();
      adjustment.data.id = adjustmentId;
      adjustment.data.transaction_id = transactionId;
      adjustment.data.totals.total = items[0].amount;

      return jsonResponse(adjustment, 201);
    });

    return adjustmentId;
  };

  const paymentRowsOf = (transactionId: string): Promise<Payment[]> =>
    db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.provider, 'paddle'),
          eq(payments.providerPaymentId, transactionId),
        ),
      );

  const paymentOf = async (paymentId: string): Promise<Payment> => {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment;
  };

  const refundsOf = (paymentId: string): Promise<Refund[]> =>
    db.select().from(refunds).where(eq(refunds.paymentId, paymentId));

  const inboxRowsWithKey = (...dedupKeys: string[]): Promise<WebhookEvent[]> =>
    db
      .select()
      .from(webhookEvents)
      .where(inArray(webhookEvents.dedupKey, dedupKeys));

  beforeAll(async () => {
    app = await createE2eApp({
      paddleEnv: {
        PADDLE_API_KEY: API_KEY,
        PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        PADDLE_CLIENT_TOKEN: CLIENT_TOKEN,
      },
      paddleProvider: new PaddleProvider(
        { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET },
        stubFetch,
        () => FIXED_NOW_MS,
      ),
    });
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    fetchHandlers.clear();
    stubFetch.mockClear();
    jest.restoreAllMocks();
  });

  describe('payments', () => {
    it('answers 201 with the checkout url Paddle returned', async () => {
      const payment = await createPaddlePayment(uniqueAmountMinor());

      expect(payment.checkoutUrl).toBe(
        `${CHECKOUT_PAGE_BASE}?_ptxn=${payment.transactionId}`,
      );
      expect(stubFetch).toHaveBeenCalledTimes(1);
      expect(requestBodyOf(stubFetch.mock.calls[0][1])).toMatchObject({
        custom_data: { reference: payment.paymentId },
      });
      expect(await paymentOf(payment.paymentId)).toMatchObject({
        status: 'pending',
        provider: 'paddle',
        providerPaymentId: payment.transactionId,
      });
    });

    it(
      'links a transaction.completed that arrives before the 201 by custom_data and ends with one succeeded row',
      async () => {
        const amountMinor = uniqueAmountMinor();

        const payment = await createPaddlePayment(
          amountMinor,
          async (reference, transactionId) => {
            await deliverAndProcess(
              completedEventFor(transactionId, reference, amountMinor),
            );
          },
        );

        const rows = await paymentRowsOf(payment.transactionId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: payment.paymentId,
          status: 'succeeded',
          providerPaymentId: payment.transactionId,
          amountMinor,
          currency: 'USD',
        });
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it('fails the inbox row and keeps the payment when the total differs', async () => {
      const amountMinor = uniqueAmountMinor();
      const payment = await createPaddlePayment(amountMinor);
      const event = completedEventFor(
        payment.transactionId,
        payment.paymentId,
        amountMinor + 1,
      );

      await deliverAndProcess(event);

      const [row] = await inboxRowsWithKey(event.event_id);
      expect(row).toMatchObject({
        provider: 'paddle',
        status: 'failed',
        lastError: `Payment ${payment.paymentId} mismatch: stored ${amountMinor} USD, received ${amountMinor + 1} USD`,
      });
      expect((await paymentOf(payment.paymentId)).status).toBe('pending');
    });
  });

  describe('refunds', () => {
    it(
      'answers a partial refund pending, then settles it from adjustment.updated',
      async () => {
        const amountMinor = uniqueAmountMinor();
        const payment = await succeededPayment(amountMinor);
        const adjustmentId = stubRefund(payment.transactionId, amountMinor);

        const response = await authorizedPost(
          `${PAYMENTS_PATH}/${payment.paymentId}/refunds`,
        )
          .send({ amountMinor: 400 })
          .expect(201);

        expect(response.body).toMatchObject({
          paymentId: payment.paymentId,
          status: 'pending',
        });
        expect(requestBodyOf(stubFetch.mock.calls.at(-1)?.[1])).toMatchObject({
          type: 'partial',
          items: [{ type: 'partial', amount: '400' }],
        });
        expect((await paymentOf(payment.paymentId)).status).toBe('succeeded');

        await deliverAndProcess(
          adjustmentEventFor(
            'event-adjustment-updated-approved',
            adjustmentId,
            payment.transactionId,
            400,
          ),
        );

        const refundRows = await refundsOf(payment.paymentId);
        expect(refundRows).toHaveLength(1);
        expect(refundRows[0]).toMatchObject({
          status: 'succeeded',
          providerRefundId: adjustmentId,
          amountMinor: 400,
        });
        expect((await paymentOf(payment.paymentId)).status).toBe(
          'partially_refunded',
        );
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'records one refund when adjustment.created arrives before the API answer',
      async () => {
        const amountMinor = uniqueAmountMinor();
        const payment = await succeededPayment(amountMinor);
        const adjustmentId = stubRefund(
          payment.transactionId,
          amountMinor,
          async (createdAdjustmentId) => {
            await deliverAndProcess(
              adjustmentEventFor(
                'event-adjustment-created',
                createdAdjustmentId,
                payment.transactionId,
                400,
              ),
            );
          },
        );

        const response = await authorizedPost(
          `${PAYMENTS_PATH}/${payment.paymentId}/refunds`,
        )
          .send({ amountMinor: 400 })
          .expect(201);

        const refundRows = await refundsOf(payment.paymentId);
        expect(refundRows).toHaveLength(1);
        expect(refundRows[0]).toMatchObject({
          id: (response.body as { refundId: string }).refundId,
          status: 'pending',
          providerRefundId: adjustmentId,
        });
        expect((await paymentOf(payment.paymentId)).status).toBe('succeeded');
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('webhook signatures', () => {
    it('answers 401 and stores an invalid row for a bad signature', async () => {
      const event = transactionEventFixture('event-transaction-paid');
      event.event_id = syntheticPaddleId('evt');
      const webhook = signedPaddleWebhook(
        event,
        'pdl_ntfset_wrong',
        FIXED_NOW_MS,
      );

      await deliver(
        app,
        webhook.rawBody,
        webhook.headers[PADDLE_SIGNATURE_HEADER] as string,
      ).expect(401);

      expect(
        await inboxRowsWithKey(event.event_id, invalidKeyOf(webhook.rawBody)),
      ).toEqual([
        expect.objectContaining({
          provider: 'paddle',
          dedupKey: invalidKeyOf(webhook.rawBody),
          signatureValid: false,
        }),
      ]);
    });
  });

  describe('checkout page', () => {
    const nonceOf = (contentSecurityPolicy: string): string | undefined =>
      /script-src 'nonce-([^']+)'/.exec(contentSecurityPolicy)?.[1];

    it('serves Paddle.js with the client token and a fresh nonce, without an API key', async () => {
      const first = await request(serverOf(app))
        .get('/checkout/paddle')
        .query({ _ptxn: syntheticPaddleId('txn') })
        .expect(200);
      const second = await request(serverOf(app))
        .get('/checkout/paddle')
        .expect(200);

      const nonce = nonceOf(first.headers['content-security-policy']);
      expect(first.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.text).toContain(
        'src="https://cdn.paddle.com/paddle/v2/paddle.js"',
      );
      expect(first.text).toContain("Paddle.Environment.set('sandbox');");
      expect(first.text).toContain(`token: "${CLIENT_TOKEN}"`);
      expect(first.text).toContain(`<script nonce="${nonce}">`);
      expect(nonce).toEqual(expect.any(String));
      expect(nonceOf(second.headers['content-security-policy'])).not.toBe(
        nonce,
      );
    });

    it('never puts the API key, the webhook secret or the query into the page', async () => {
      const injected = '<script>alert(1)</script>';

      const response = await request(serverOf(app))
        .get('/checkout/paddle')
        .query({ _ptxn: injected, token: 'test_attacker' })
        .expect(200);

      expect(response.text).not.toContain(API_KEY);
      expect(response.text).not.toContain(WEBHOOK_SECRET);
      expect(response.text).not.toContain(injected);
      expect(response.text).not.toContain('alert(1)');
      expect(response.text).not.toContain('test_attacker');
    });
  });
});

describe('Paddle provider without configuration', () => {
  let app: INestApplication;
  let db: Database;

  beforeAll(async () => {
    app = await createE2eApp();
    db = app.get<Database>(DRIZZLE);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers paddle webhooks 503 and stores nothing', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const event = transactionEventFixture('event-transaction-paid');
    event.event_id = syntheticPaddleId('evt');
    const webhook = signedPaddleWebhook(event, WEBHOOK_SECRET, Date.now());

    await request(serverOf(app))
      .post('/webhooks/paddle')
      .set('Content-Type', 'application/json')
      .set(
        PADDLE_SIGNATURE_HEADER,
        webhook.headers[PADDLE_SIGNATURE_HEADER] as string,
      )
      .serialize(sendBytesAsTheyAre)
      .send(webhook.rawBody)
      .expect(503);

    expect(
      await db
        .select()
        .from(webhookEvents)
        .where(
          inArray(webhookEvents.dedupKey, [
            event.event_id,
            invalidKeyOf(webhook.rawBody),
          ]),
        ),
    ).toHaveLength(0);
  });

  it('answers a paddle payment 503 provider_unavailable', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const response = await request(serverOf(app))
      .post(PAYMENTS_PATH)
      .set('Authorization', `Bearer ${TEST_API_KEY}`)
      .set('Idempotency-Key', `paddle-${syntheticPaddleId('key')}`)
      .send({
        provider: 'paddle',
        amountMinor: uniqueAmountMinor(),
        currency: 'USD',
        description: 'unconfigured paddle order',
        returnUrl: 'https://shop.example.test/return',
      })
      .expect(503);

    expect(response.body).toMatchObject({ code: 'provider_unavailable' });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('PADDLE_API_KEY is not configured'),
    );
  });

  it('answers the checkout page 503 with a generic body and logs an error', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const response = await request(serverOf(app))
      .get('/checkout/paddle')
      .expect(503);

    expect(response.body).toEqual({
      statusCode: 503,
      message: 'Service Unavailable',
    });
    expect(response.text).not.toContain('test_');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('PADDLE_CLIENT_TOKEN'),
    );
  });
});
