import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Logger, type INestApplication } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import { idempotencyKeys } from '@/database/schemas/idempotency-keys.schema';
import { payments, type Payment } from '@/database/schemas/payments.schema';
import { projects } from '@/database/schemas/projects.schema';
import { providerAccounts } from '@/database/schemas/provider-accounts.schema';
import { refunds, type Refund } from '@/database/schemas/refunds.schema';
import {
  webhookEvents,
  type WebhookEvent,
} from '@/database/schemas/webhook-events.schema';
import {
  SEED_STRIPE_ACCOUNT_ID,
  SEED_STRIPE_CREDENTIALS_REF,
} from '@/provider-accounts/provider-accounts.constants';
import {
  checkoutUrlOf,
  errorBodyFixture,
  eventFixture,
  paidSessionFixture,
  refundFixture,
  sessionFixture,
  signedStripeWebhook,
  STRIPE_SIGNATURE_HEADER,
  syntheticStripeId,
  type StripeSessionFixture,
} from '@/providers/stripe/fixtures/stripe-fixtures';
import { STRIPE_API_VERSION } from '@/providers/stripe/stripe-http';
import { signatureHeaderOf } from '@/providers/stripe/stripe-signature';
import { StripeProvider } from '@/providers/stripe/stripe.provider';

import {
  createE2eApp,
  SEED_STRIPE_WEBHOOK_PATH,
  serverOf,
  TEST_API_KEY,
} from './helpers';
import { insertApiKey } from './two-projects';
import { tick } from './webhook-replay';

type FetchHandler = (init: RequestInit | undefined) => Promise<Response>;

type ActiveAccount = { accountId: string; apiKey: string; webhookPath: string };

type CreatedStripePayment = {
  paymentId: string;
  sessionId: string;
  checkoutUrl: string;
};

const SECRET_KEY = `sk_test_${'E2eKey0'.repeat(14)}`;
const WEBHOOK_SECRET = 'whsec_E2eSyntheticSecret00000000000001';
const FIXED_NOW_EPOCH_MS = 1_762_855_200_000;
const STRIPE_API = 'https://api.stripe.com';
const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const RETURN_URL = 'https://shop.example.test/return';
const AMOUNT_MINOR = 734;
const SLOW_TEST_TIMEOUT_MS = 60000;
const PROCESS_DEADLINE_MS = 15000;
const PROCESS_POLL_MS = 100;
const SIGNATURE_SKEW_MS = 10 * 1000;
const UNCONFIRMED_REFUND_WINDOW_SECONDS = 120;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_e2e' },
  });

const formOf = (init: RequestInit | undefined): Record<string, string> =>
  typeof init?.body === 'string'
    ? Object.fromEntries(new URLSearchParams(init.body))
    : {};

const sendBytesAsTheyAre = (rawBody: unknown): string => rawBody as string;

const invalidKeyOf = (rawBody: Buffer): string =>
  `invalid:${createHash('sha256').update(rawBody).digest('hex')}`;

const sessionEventFor = (
  type: string,
  overrides: Partial<StripeSessionFixture>,
) => eventFixture(type, sessionFixture(overrides));

const muteLogs = () => ({
  warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
  error: jest.spyOn(Logger.prototype, 'error').mockImplementation(),
});

const insertActiveStripeAccount = async (
  db: Database,
): Promise<ActiveAccount> => {
  const projectId = randomUUID();
  const accountId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    slug: `project-stripe-${randomBytes(4).toString('hex')}`,
    name: 'Project Stripe',
    allowedReturnOrigins: ['https://shop.example.test'],
  });
  await db.insert(providerAccounts).values({
    id: accountId,
    projectId,
    provider: 'stripe',
    status: 'active',
    credentialsRef: SEED_STRIPE_CREDENTIALS_REF,
  });
  const { apiKey } = await insertApiKey(db, projectId);

  return { accountId, apiKey, webhookPath: `/webhooks/stripe/${accountId}` };
};

describe('Stripe provider', () => {
  const fetchHandlers = new Map<string, FetchHandler>();
  const stubFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>(
    (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const key = `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`;
      const handler = fetchHandlers.get(key);
      if (!handler) throw new Error(`Unexpected Stripe request ${key}`);

      return handler(init);
    },
  );

  let app: INestApplication;
  let db: Database;
  let active: ActiveAccount;

  const deliver = (
    rawBody: Buffer,
    signature: string | undefined,
    path = active.webhookPath,
  ) => {
    const delivery = request(serverOf(app))
      .post(path)
      .set('Content-Type', 'application/json');
    if (signature !== undefined) {
      delivery.set(STRIPE_SIGNATURE_HEADER, signature);
    }

    return delivery.serialize(sendBytesAsTheyAre).send(rawBody);
  };

  const deliverSigned = (
    body: unknown,
    path = active.webhookPath,
    signedAtEpochMs = FIXED_NOW_EPOCH_MS,
  ) => {
    const webhook = signedStripeWebhook(body, WEBHOOK_SECRET, signedAtEpochMs);

    return deliver(
      webhook.rawBody,
      webhook.headers[STRIPE_SIGNATURE_HEADER] as string,
      path,
    );
  };

  const inboxRowsOf = (
    accountId: string,
    ...dedupKeys: string[]
  ): Promise<WebhookEvent[]> =>
    db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.providerAccountId, accountId),
          inArray(webhookEvents.dedupKey, dedupKeys),
        ),
      );

  // Another spec file's drain may claim the row first, so wait for its outcome.
  const waitProcessed = async (
    accountId: string,
    dedupKey: string,
  ): Promise<WebhookEvent> => {
    const deadline = Date.now() + PROCESS_DEADLINE_MS;

    for (;;) {
      await tick(app);
      const [row] = await inboxRowsOf(accountId, dedupKey);
      if (row && row.status !== 'received') return row;
      if (Date.now() > deadline) {
        throw new Error(`Inbox row ${dedupKey} was not processed`);
      }
      await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
    }
  };

  const deliverAndProcess = async (
    event: { id: string },
    path = active.webhookPath,
    accountId = active.accountId,
  ): Promise<WebhookEvent> => {
    await deliverSigned(event, path).expect(200);

    return waitProcessed(accountId, event.id);
  };

  const postPayment = (
    body: Record<string, unknown>,
    apiKey = active.apiKey,
    idempotencyKey = `stripe-${randomUUID()}`,
  ) =>
    request(serverOf(app))
      .post(PAYMENTS_PATH)
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        provider: 'stripe',
        amountMinor: AMOUNT_MINOR,
        currency: 'USD',
        description: 'e2e stripe order',
        returnUrl: RETURN_URL,
        ...body,
      });

  const postRefund = (paymentId: string, amountMinor: number) =>
    request(serverOf(app))
      .post(`${PAYMENTS_PATH}/${paymentId}/refunds`)
      .set('Authorization', `Bearer ${active.apiKey}`)
      .set('Idempotency-Key', `stripe-${randomUUID()}`)
      .send({ amountMinor });

  const stubCreatedSession = (
    overrides: Partial<StripeSessionFixture> = {},
    beforeAnswer: (
      reference: string,
      sessionId: string,
    ) => Promise<void> = () => Promise.resolve(),
  ): string => {
    const sessionId = overrides.id ?? syntheticStripeId('cs_test');
    fetchHandlers.set(
      `POST ${STRIPE_API}/v1/checkout/sessions`,
      async (init) => {
        const form = formOf(init);
        await beforeAnswer(form.client_reference_id, sessionId);

        return jsonResponse(
          sessionFixture({
            id: sessionId,
            client_reference_id: form.client_reference_id,
            amount_total: Number(
              form['line_items[0][price_data][unit_amount]'],
            ),
            currency: form['line_items[0][price_data][currency]'],
            ...overrides,
          }),
        );
      },
    );

    return sessionId;
  };

  const createStripePayment = async (
    beforeAnswer?: (reference: string, sessionId: string) => Promise<void>,
  ): Promise<CreatedStripePayment> => {
    const sessionId = stubCreatedSession({}, beforeAnswer);
    const response = await postPayment({}).expect(201);
    const body = response.body as {
      paymentId: string;
      checkout: { url: string };
    };

    return {
      paymentId: body.paymentId,
      sessionId,
      checkoutUrl: body.checkout.url,
    };
  };

  const paidEventFor = (
    payment: CreatedStripePayment,
    overrides: Partial<StripeSessionFixture> = {},
  ) =>
    sessionEventFor('checkout.session.completed', {
      id: payment.sessionId,
      client_reference_id: payment.paymentId,
      status: 'complete',
      payment_status: 'paid',
      ...overrides,
    });

  const succeededPayment = async (): Promise<CreatedStripePayment> => {
    const payment = await createStripePayment();
    await deliverAndProcess(paidEventFor(payment));

    return payment;
  };

  const paymentOf = async (paymentId: string): Promise<Payment> => {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment;
  };

  const paymentIdOfKey = async (key: string): Promise<string | null> => {
    const [row] = await db
      .select({ paymentId: idempotencyKeys.paymentId })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, 'api:create_payment'),
          eq(idempotencyKeys.key, key),
        ),
      );

    return row?.paymentId ?? null;
  };

  const refundsOf = (paymentId: string): Promise<Refund[]> =>
    db.select().from(refunds).where(eq(refunds.paymentId, paymentId));

  beforeAll(async () => {
    app = await createE2eApp({
      stripeEnv: {
        STRIPE_SECRET_KEY: SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stripeProvider: new StripeProvider(stubFetch, () => FIXED_NOW_EPOCH_MS),
    });
    await app.listen(0);
    db = app.get<Database>(DRIZZLE);
    active = await insertActiveStripeAccount(db);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    fetchHandlers.clear();
    stubFetch.mockClear();
    jest.restoreAllMocks();
  });

  describe('the disabled seed account', () => {
    it('answers 422 provider_not_available and stores no payment and no key', async () => {
      const key = `stripe-${randomUUID()}`;
      const countOnSeedAccount = async () =>
        (
          await db
            .select({ id: payments.id })
            .from(payments)
            .where(eq(payments.providerAccountId, SEED_STRIPE_ACCOUNT_ID))
        ).length;
      const before = await countOnSeedAccount();

      const response = await postPayment({}, TEST_API_KEY, key).expect(422);

      expect(response.body).toMatchObject({ code: 'provider_not_available' });
      expect(await countOnSeedAccount()).toBe(before);
      expect(
        await db
          .select()
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, key)),
      ).toEqual([]);
      expect(stubFetch).not.toHaveBeenCalled();
    });

    it('still takes signed webhooks', async () => {
      const event = eventFixture('charge.refunded', { id: 'ch_1' });

      await deliverSigned(event, SEED_STRIPE_WEBHOOK_PATH).expect(200);

      expect(await inboxRowsOf(SEED_STRIPE_ACCOUNT_ID, event.id)).toEqual([
        expect.objectContaining({ provider: 'stripe', signatureValid: true }),
      ]);
    });

    it('is 404 on the paddle route and stores nothing', async () => {
      const event = eventFixture('charge.refunded', { id: 'ch_1' });
      const webhook = signedStripeWebhook(
        event,
        WEBHOOK_SECRET,
        FIXED_NOW_EPOCH_MS,
      );

      await deliver(
        webhook.rawBody,
        webhook.headers[STRIPE_SIGNATURE_HEADER] as string,
        `/webhooks/paddle/${SEED_STRIPE_ACCOUNT_ID}`,
      ).expect(404);

      expect(
        await db
          .select()
          .from(webhookEvents)
          .where(
            inArray(webhookEvents.dedupKey, [
              event.id,
              invalidKeyOf(webhook.rawBody),
            ]),
          ),
      ).toEqual([]);
    });
  });

  describe('payments', () => {
    it('answers 201 with the Checkout url after one form POST', async () => {
      const payment = await createStripePayment();

      expect(payment.checkoutUrl).toBe(checkoutUrlOf(payment.sessionId));
      expect(payment.checkoutUrl).toMatch(
        /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/,
      );
      expect(await paymentOf(payment.paymentId)).toMatchObject({
        status: 'pending',
        provider: 'stripe',
        providerAccountId: active.accountId,
        providerPaymentId: payment.sessionId,
      });
      expect(stubFetch).toHaveBeenCalledTimes(1);
      const [url, init] = stubFetch.mock.calls[0];
      expect(url).toBe(`${STRIPE_API}/v1/checkout/sessions`);
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${SECRET_KEY}`,
        'Stripe-Version': STRIPE_API_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `payvolok-payment-${payment.paymentId}`,
      });
      const form = formOf(init);
      expect(form).toMatchObject({
        mode: 'payment',
        'line_items[0][price_data][unit_amount]': '734',
        'line_items[0][price_data][currency]': 'usd',
        client_reference_id: payment.paymentId,
        'payment_intent_data[metadata][payvolok_reference]': payment.paymentId,
        success_url: RETURN_URL,
        cancel_url: RETURN_URL,
        'adaptive_pricing[enabled]': 'false',
      });
      expect(Object.keys(form)).not.toContain('payment_method_types');
      expect(Object.keys(form)).not.toContain('expires_at');
    });

    it.each(['GBP', 'JPY'])(
      'answers %s 422 order_rejected, fails the payment and calls nothing',
      async (currency) => {
        muteLogs();
        const key = `stripe-${randomUUID()}`;

        const response = await postPayment(
          { currency },
          active.apiKey,
          key,
        ).expect(422);

        expect(response.body).toMatchObject({ code: 'order_rejected' });
        const paymentId = await paymentIdOfKey(key);
        expect((await paymentOf(paymentId as string)).status).toBe('failed');
        expect(stubFetch).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['an http url', { url: 'http://checkout.stripe.com/c/pay/x' }],
      ['a live session id', { id: syntheticStripeId('cs_live') }],
    ])('answers %s 503 and fails the payment', async (_case, overrides) => {
      muteLogs();
      stubCreatedSession(overrides);
      const key = `stripe-${randomUUID()}`;

      const response = await postPayment({}, active.apiKey, key).expect(503);

      expect(response.body).toMatchObject({ code: 'provider_unavailable' });
      const { paymentId } = response.body as { paymentId: string };
      expect((await paymentOf(paymentId)).status).toBe('failed');
    });

    it(
      'links a completed event processed before create stored the session id, and keeps one row',
      async () => {
        const payment = await createStripePayment(
          async (reference, sessionId) => {
            await deliverAndProcess(
              sessionEventFor('checkout.session.completed', {
                id: sessionId,
                client_reference_id: reference,
                status: 'complete',
                payment_status: 'paid',
              }),
            );
          },
        );

        const rows = await db
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.providerAccountId, active.accountId),
              eq(payments.providerPaymentId, payment.sessionId),
            ),
          );
        expect(rows).toEqual([
          expect.objectContaining({
            id: payment.paymentId,
            status: 'succeeded',
            amountMinor: AMOUNT_MINOR,
            currency: 'USD',
          }),
        ]);
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  describe('webhook events', () => {
    it.each([
      ['checkout.session.completed', 'paid', 'succeeded'],
      ['checkout.session.completed', 'unpaid', 'pending'],
      ['checkout.session.async_payment_succeeded', 'paid', 'succeeded'],
      ['checkout.session.async_payment_failed', 'unpaid', 'failed'],
      ['checkout.session.expired', 'unpaid', 'expired'],
    ])(
      'applies %s with %s as %s and processes the row',
      async (type, paymentStatus, status) => {
        const payment = await createStripePayment();
        const event = sessionEventFor(type, {
          id: payment.sessionId,
          client_reference_id: payment.paymentId,
          payment_status: paymentStatus,
        });

        const row = await deliverAndProcess(event);

        expect(row).toMatchObject({ status: 'processed', lastError: null });
        expect((await paymentOf(payment.paymentId)).status).toBe(status);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it('keeps the reason of an async payment failure', async () => {
      const payment = await createStripePayment();

      const row = await deliverAndProcess(
        sessionEventFor('checkout.session.async_payment_failed', {
          id: payment.sessionId,
          client_reference_id: payment.paymentId,
        }),
      );

      expect(row.failureReason).toBe('stripe_async_payment_failed');
    });

    it(
      'ignores refund, charge and payment intent events and sessions it must not apply, changing nothing',
      async () => {
        const payment = await succeededPayment();
        const before = await paymentOf(payment.paymentId);
        const sessionOf = (overrides: Partial<StripeSessionFixture>) =>
          paidEventFor(payment, overrides);
        const events = [
          eventFixture('charge.refunded', { id: 'ch_1', object: 'charge' }),
          eventFixture('refund.updated', refundFixture()),
          eventFixture('payment_intent.payment_failed', { id: 'pi_1' }),
          { ...sessionOf({}), livemode: true },
          sessionOf({ mode: 'subscription' }),
          sessionOf({ id: syntheticStripeId('cs_live') }),
        ];

        for (const event of events) {
          const row = await deliverAndProcess(event);
          expect(row.status).toBe('ignored');
        }

        const rawBody = Buffer.from(`not json ${randomUUID()}`);
        await deliver(
          rawBody,
          signatureHeaderOf(rawBody, WEBHOOK_SECRET, FIXED_NOW_EPOCH_MS),
        ).expect(200);
        const bodyKey = `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
        expect((await waitProcessed(active.accountId, bodyKey)).status).toBe(
          'ignored',
        );

        expect(await refundsOf(payment.paymentId)).toEqual([]);
        const after = await paymentOf(payment.paymentId);
        expect(after.status).toBe('succeeded');
        expect(after.updatedAt).toEqual(before.updatedAt);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    it('fails the row on an amount or currency that differs from the payment', async () => {
      const payment = await createStripePayment();

      const amountRow = await deliverAndProcess(
        paidEventFor(payment, { amount_total: AMOUNT_MINOR + 1 }),
      );
      const currencyRow = await deliverAndProcess(
        paidEventFor(payment, { currency: 'eur' }),
      );

      expect(amountRow).toMatchObject({
        status: 'failed',
        lastError: `Payment ${payment.paymentId} mismatch: stored 734 USD, received 735 USD`,
      });
      expect(currencyRow).toMatchObject({
        status: 'failed',
        lastError: `Payment ${payment.paymentId} mismatch: stored 734 USD, received 734 EUR`,
      });
      expect((await paymentOf(payment.paymentId)).status).toBe('pending');
    });

    it('ignores, in one attempt, an event on another account that names this payment', async () => {
      const { warn } = muteLogs();
      const payment = await createStripePayment();
      const event = paidEventFor(payment);

      const row = await deliverAndProcess(
        event,
        SEED_STRIPE_WEBHOOK_PATH,
        SEED_STRIPE_ACCOUNT_ID,
      );

      expect(row).toMatchObject({ status: 'ignored', attempts: 1 });
      expect(row.lastError).toContain('belongs to another account');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(active.accountId),
      );
      expect((await paymentOf(payment.paymentId)).status).toBe('pending');
    });

    it('stores the same event once when Stripe resends it with another t', async () => {
      const payment = await createStripePayment();
      const event = paidEventFor(payment);

      await deliverSigned(event).expect(200);
      await deliverSigned(
        event,
        active.webhookPath,
        FIXED_NOW_EPOCH_MS - SIGNATURE_SKEW_MS,
      ).expect(200);

      expect(await inboxRowsOf(active.accountId, event.id)).toHaveLength(1);
    });

    it('stores two events of one session as two rows', async () => {
      const payment = await createStripePayment();
      const completed = paidEventFor(payment, { payment_status: 'unpaid' });
      const succeeded = sessionEventFor(
        'checkout.session.async_payment_succeeded',
        { id: payment.sessionId, client_reference_id: payment.paymentId },
      );

      await deliverAndProcess(completed);
      await deliverAndProcess(succeeded);

      expect(
        await inboxRowsOf(active.accountId, completed.id, succeeded.id),
      ).toHaveLength(2);
      expect((await paymentOf(payment.paymentId)).status).toBe('succeeded');
    });
  });

  describe('webhook signatures', () => {
    it.each([
      [
        'a wrong secret',
        () => {
          const event = eventFixture('charge.refunded', { id: 'ch_1' });
          const webhook = signedStripeWebhook(
            event,
            'whsec_WrongSecret0000000001',
            FIXED_NOW_EPOCH_MS,
          );

          return {
            rawBody: webhook.rawBody,
            signature: webhook.headers[STRIPE_SIGNATURE_HEADER] as string,
          };
        },
      ],
      [
        'a tampered body',
        () => {
          const event = eventFixture('charge.refunded', { id: 'ch_1' });
          const webhook = signedStripeWebhook(
            event,
            WEBHOOK_SECRET,
            FIXED_NOW_EPOCH_MS,
          );

          return {
            rawBody: Buffer.from(
              webhook.rawBody.toString().replace('ch_1', 'ch_2'),
            ),
            signature: webhook.headers[STRIPE_SIGNATURE_HEADER] as string,
          };
        },
      ],
    ])(
      'answers %s 401 with an invalid row on the account',
      async (_case, build) => {
        const { rawBody, signature } = build();

        await deliver(rawBody, signature).expect(401);

        expect(
          await inboxRowsOf(active.accountId, invalidKeyOf(rawBody)),
        ).toEqual([
          expect.objectContaining({
            provider: 'stripe',
            signatureValid: false,
          }),
        ]);
      },
    );

    it('answers a missing header 401', async () => {
      await deliver(Buffer.from('{}'), undefined).expect(401);
    });
  });

  describe('refunds', () => {
    const stubPaidSession = (
      payment: CreatedStripePayment,
      overrides: Partial<StripeSessionFixture> = {},
    ): string => {
      const paymentIntentId = syntheticStripeId('pi');
      fetchHandlers.set(
        `GET ${STRIPE_API}/v1/checkout/sessions/${payment.sessionId}`,
        () =>
          Promise.resolve(
            jsonResponse(
              paidSessionFixture({
                id: payment.sessionId,
                client_reference_id: payment.paymentId,
                payment_intent: paymentIntentId,
                ...overrides,
              }),
            ),
          ),
      );

      return paymentIntentId;
    };

    const stubRefundAnswer = (answer: FetchHandler): void => {
      fetchHandlers.set(`POST ${STRIPE_API}/v1/refunds`, answer);
    };

    const postsOf = () =>
      stubFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

    it('records a succeeded refund with its re_ id and the payment partially refunded', async () => {
      const payment = await succeededPayment();
      const paymentIntentId = stubPaidSession(payment);
      const refundId = syntheticStripeId('re');
      stubRefundAnswer((init) =>
        Promise.resolve(
          jsonResponse(
            refundFixture({
              id: refundId,
              amount: Number(formOf(init).amount),
              payment_intent: paymentIntentId,
            }),
          ),
        ),
      );
      stubFetch.mockClear();

      const response = await postRefund(payment.paymentId, 200).expect(201);

      expect(response.body).toMatchObject({
        paymentId: payment.paymentId,
        status: 'succeeded',
      });
      const refundRows = await refundsOf(payment.paymentId);
      expect(refundRows).toEqual([
        expect.objectContaining({
          id: (response.body as { refundId: string }).refundId,
          providerRefundId: refundId,
          origin: 'api',
          status: 'succeeded',
          amountMinor: 200,
        }),
      ]);
      expect((await paymentOf(payment.paymentId)).status).toBe(
        'partially_refunded',
      );
      const [[, post]] = postsOf();
      expect(post?.headers).toMatchObject({
        'Idempotency-Key': `payvolok-refund-${refundRows[0].id}`,
      });
      expect(formOf(post)).toEqual({
        payment_intent: paymentIntentId,
        amount: '200',
        'metadata[payvolok_refund_reference]': refundRows[0].id,
      });
    });

    it('answers a pending refund 201 pending', async () => {
      const payment = await succeededPayment();
      stubPaidSession(payment);
      stubRefundAnswer(() =>
        Promise.resolve(jsonResponse(refundFixture({ status: 'pending' }))),
      );

      const response = await postRefund(payment.paymentId, 200).expect(201);

      expect(response.body).toMatchObject({ status: 'pending' });
    });

    it('answers a refused refund 422 refund_rejected and stores no row', async () => {
      muteLogs();
      const payment = await succeededPayment();
      stubPaidSession(payment);
      stubRefundAnswer(() =>
        Promise.resolve(
          jsonResponse(
            errorBodyFixture(
              'invalid_request_error',
              'charge_already_refunded',
            ),
            400,
          ),
        ),
      );

      const response = await postRefund(payment.paymentId, 200).expect(422);

      expect(response.body).toMatchObject({ code: 'refund_rejected' });
      expect(await refundsOf(payment.paymentId)).toEqual([]);
    });

    it('answers a timed-out refund 503, stores no row and checks again within 2 minutes', async () => {
      muteLogs();
      const payment = await succeededPayment();
      stubPaidSession(payment);
      stubRefundAnswer(() =>
        Promise.reject(new DOMException('timed out', 'TimeoutError')),
      );

      const response = await postRefund(payment.paymentId, 200).expect(503);

      expect(response.body).toMatchObject({ code: 'provider_unavailable' });
      expect(await refundsOf(payment.paymentId)).toEqual([]);
      const [{ isSoon }] = await db.execute<{ isSoon: boolean }>(sql`
        select reconcile_after <= now() + ${UNCONFIRMED_REFUND_WINDOW_SECONDS}::integer * interval '1 second' as "isSoon"
        from payments where id = ${payment.paymentId}
      `);
      expect(isSoon).toBe(true);
    });

    it('rejects a refund of an unpaid session without a POST', async () => {
      muteLogs();
      const payment = await succeededPayment();
      stubPaidSession(payment, { payment_status: 'unpaid', status: 'open' });
      stubFetch.mockClear();

      await postRefund(payment.paymentId, 200).expect(422);

      expect(postsOf()).toEqual([]);
    });

    it('refuses more than the remaining amount before calling Stripe', async () => {
      const payment = await succeededPayment();
      stubFetch.mockClear();

      const response = await postRefund(
        payment.paymentId,
        AMOUNT_MINOR + 1,
      ).expect(422);

      expect(response.body).toMatchObject({
        code: 'refund_amount_exceeds_remaining',
      });
      expect(stubFetch).not.toHaveBeenCalled();
    });
  });
});

describe('Stripe provider without configuration', () => {
  let app: INestApplication;
  let db: Database;
  let active: ActiveAccount;

  beforeAll(async () => {
    app = await createE2eApp();
    db = app.get<Database>(DRIZZLE);
    active = await insertActiveStripeAccount(db);
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers stripe webhooks 503 and stores nothing', async () => {
    muteLogs();
    const event = eventFixture('charge.refunded', { id: 'ch_1' });
    const webhook = signedStripeWebhook(event, WEBHOOK_SECRET, Date.now());

    await request(serverOf(app))
      .post(active.webhookPath)
      .set('Content-Type', 'application/json')
      .set(
        STRIPE_SIGNATURE_HEADER,
        webhook.headers[STRIPE_SIGNATURE_HEADER] as string,
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
            event.id,
            invalidKeyOf(webhook.rawBody),
          ]),
        ),
    ).toEqual([]);
  });

  it('answers a stripe payment 503 provider_unavailable, fails it and calls nothing', async () => {
    const { error } = muteLogs();

    const response = await request(serverOf(app))
      .post(PAYMENTS_PATH)
      .set('Authorization', `Bearer ${active.apiKey}`)
      .set('Idempotency-Key', `stripe-${randomUUID()}`)
      .send({
        provider: 'stripe',
        amountMinor: AMOUNT_MINOR,
        currency: 'USD',
        description: 'unconfigured stripe order',
        returnUrl: RETURN_URL,
      })
      .expect(503);

    expect(response.body).toMatchObject({ code: 'provider_unavailable' });
    const [payment] = await db
      .select()
      .from(payments)
      .where(
        eq(payments.id, (response.body as { paymentId: string }).paymentId),
      );
    expect(payment.status).toBe('failed');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('stripe secret key is not configured'),
    );
  });
});
