import { boundProviderOf } from '../bound-provider';
import {
  ProviderError,
  type BoundProvider,
  type RefundInput,
} from '../payment-provider.port';
import {
  RedactedSecret,
  type StripeCredentials,
} from '../provider-credentials';

import {
  checkoutUrlOf,
  errorBodyFixture,
  eventFixture,
  paidSessionFixture,
  paymentIntentFixture,
  refundFixture,
  refundListFixture,
  sessionFixture,
  signedStripeWebhook,
  type StripeSessionFixture,
} from './fixtures/stripe-fixtures';
import {
  STRIPE_API_VERSION,
  STRIPE_MAX_REQUESTS_PER_CALL,
} from './stripe-http';
import { StripeProvider } from './stripe.provider';

type FetchMock = jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

const SECRET_KEY = `sk_test_${'Key1'.repeat(24)}`;
const WEBHOOK_SECRET = 'whsec_SyntheticSecret0000000000000001';
const OTHER_WEBHOOK_SECRET = 'whsec_SyntheticSecret0000000000000002';
const NOW_EPOCH_MS = 1_762_855_200_000;
const ACCOUNT = {
  id: '0b9d6f0e-5a4b-4c1e-9f3a-aaaaaaaaaaaa',
  projectId: '0b9d6f0e-5a4b-4c1e-9f3a-bbbbbbbbbbbb',
};
const SESSION_ID = 'cs_test_a1SyntheticSession0000000001';
const PAYMENT_INTENT_ID = 'pi_3SyntheticIntent000000001';
const REFUND_ID = 're_3SyntheticRefund000000001';
const REFERENCE = '5b0b3a0e-6f0c-4c43-9d5e-0a8a7d5e1c11';
const RETURN_URL = 'https://shop.example.test/return';

const PAYMENT_INPUT = {
  reference: REFERENCE,
  amountMinor: 734,
  currency: 'USD',
  description: 'e2e order',
  returnUrl: RETURN_URL,
  webhookUrl: 'https://payvolok.example.test/webhooks/stripe/x',
};

const REFUND_INPUT: RefundInput = {
  reference: '8c6f9a52-0d6c-4c8e-9a7b-1f2e3d4c5b6a',
  providerPaymentId: SESSION_ID,
  amountMinor: 200,
  currency: 'USD',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
  });

const fetchAnswering = (...responses: Response[]): FetchMock => {
  const queue = [...responses];

  return jest.fn<Promise<Response>, Parameters<typeof fetch>>(() => {
    const response = queue.shift();
    if (!response) throw new Error('Unexpected Stripe request');

    return Promise.resolve(response);
  });
};

const credentialsWith = (
  overrides: Partial<StripeCredentials> = {},
): StripeCredentials => ({
  provider: 'stripe',
  secretKey: new RedactedSecret(SECRET_KEY),
  webhookSecrets: [new RedactedSecret(WEBHOOK_SECRET)],
  ...overrides,
});

const providerWith = (
  fetchFn: FetchMock,
  overrides: Partial<StripeCredentials> = {},
): BoundProvider =>
  boundProviderOf(
    ACCOUNT,
    new StripeProvider(fetchFn, () => NOW_EPOCH_MS),
    credentialsWith(overrides),
  );

const requestOf = (fetchFn: FetchMock, index: number) => {
  const [url, init] = fetchFn.mock.calls[index];
  const parsedUrl = new URL(url as string);

  return {
    method: init?.method,
    path: parsedUrl.pathname,
    query: Object.fromEntries(parsedUrl.searchParams),
    headers: init?.headers as Record<string, string>,
    form:
      typeof init?.body === 'string'
        ? Object.fromEntries(new URLSearchParams(init.body))
        : undefined,
  };
};

const expectWithinRequestBudget = (fetchFn: FetchMock): void => {
  expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(
    STRIPE_MAX_REQUESTS_PER_CALL,
  );
};

const rejectionOf = async (work: Promise<unknown>): Promise<ProviderError> => {
  const caught: unknown = await work.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(caught instanceof ProviderError)) {
    throw new Error('Expected a ProviderError');
  }

  return caught;
};

const createdSession = (overrides: Partial<StripeSessionFixture> = {}) =>
  jsonResponse(sessionFixture({ id: SESSION_ID, ...overrides }));

const paidSession = (overrides: Partial<StripeSessionFixture> = {}) =>
  jsonResponse(
    paidSessionFixture({
      id: SESSION_ID,
      payment_intent: PAYMENT_INTENT_ID,
      ...overrides,
    }),
  );

const missing = () =>
  jsonResponse(
    errorBodyFixture('invalid_request_error', 'resource_missing'),
    404,
  );

describe('StripeProvider', () => {
  it('declares provider refund identity and the signature header', () => {
    const provider = providerWith(fetchAnswering());

    expect(provider.code).toBe('stripe');
    expect(provider.capabilities).toEqual({
      recurring: 'managed',
      intervals: [],
      partialRefund: true,
      catalog: false,
      refundIdentity: 'provider',
    });
    expect(provider.webhookHeaders).toEqual(['stripe-signature']);
  });

  describe('createPayment', () => {
    it('posts one form-encoded Checkout Session and returns its url', async () => {
      const fetchFn = fetchAnswering(createdSession());

      const created = await providerWith(fetchFn).createPayment(PAYMENT_INPUT);

      expect(created).toEqual({
        providerPaymentId: SESSION_ID,
        redirectUrl: checkoutUrlOf(SESSION_ID),
        status: 'pending',
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expectWithinRequestBudget(fetchFn);
      const request = requestOf(fetchFn, 0);
      expect(request).toMatchObject({
        method: 'POST',
        path: '/v1/checkout/sessions',
        headers: {
          Authorization: `Bearer ${SECRET_KEY}`,
          'Stripe-Version': STRIPE_API_VERSION,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `payvolok-payment-${REFERENCE}`,
        },
      });
      expect(request.form).toEqual({
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': '734',
        'line_items[0][price_data][product_data][name]': 'e2e order',
        client_reference_id: REFERENCE,
        'metadata[payvolok_reference]': REFERENCE,
        'payment_intent_data[metadata][payvolok_reference]': REFERENCE,
        success_url: RETURN_URL,
        cancel_url: RETURN_URL,
        'adaptive_pricing[enabled]': 'false',
      });
    });

    it.each(['EUR', 'UAH'])('sends %s lower-cased', async (currency) => {
      const fetchFn = fetchAnswering(createdSession());

      await providerWith(fetchFn).createPayment({ ...PAYMENT_INPUT, currency });

      expect(
        requestOf(fetchFn, 0).form?.['line_items[0][price_data][currency]'],
      ).toBe(currency.toLowerCase());
    });

    it.each([
      ['GBP', { currency: 'GBP' }],
      ['JPY', { currency: 'JPY' }],
      ['a lowercase currency', { currency: 'usd' }],
      ['a zero amount', { amountMinor: 0 }],
      ['a fractional amount', { amountMinor: 10.5 }],
      ['an unsafe amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ])('rejects %s without calling Stripe', async (_case, overrides) => {
      const fetchFn = fetchAnswering();

      const rejection = await rejectionOf(
        providerWith(fetchFn).createPayment({ ...PAYMENT_INPUT, ...overrides }),
      );

      expect(rejection.kind).toBe('rejected');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('is misconfigured without a secret key and calls nothing', async () => {
      const fetchFn = fetchAnswering();

      const rejection = await rejectionOf(
        providerWith(fetchFn, { secretKey: null }).createPayment(PAYMENT_INPUT),
      );

      expect(rejection.kind).toBe('misconfigured');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each([
      ['an http url', { url: 'http://checkout.stripe.com/c/pay/x' }],
      ['no url', { url: null }],
      ['a url that is not a url', { url: 'pay here' }],
      ['a live session id', { id: 'cs_live_a1Synthetic0000000001' }],
      ['an id that is not a session', { id: 'pi_3Synthetic0000000001' }],
    ])('answers %s as unavailable', async (_case, overrides) => {
      const rejection = await rejectionOf(
        providerWith(fetchAnswering(createdSession(overrides))).createPayment(
          PAYMENT_INPUT,
        ),
      );

      expect(rejection.kind).toBe('unavailable');
    });

    it.each([
      [400, 'invalid_request_error', 'amount_too_small', 'rejected'],
      [400, 'invalid_request_error', 'parameter_unknown', 'misconfigured'],
      [401, 'invalid_request_error', null, 'misconfigured'],
      [409, 'idempotency_error', null, 'unavailable'],
      [500, 'api_error', null, 'unavailable'],
    ] as const)(
      'maps a %i %s answer to %s without the key',
      async (status, type, code, kind) => {
        const rejection = await rejectionOf(
          providerWith(
            fetchAnswering(jsonResponse(errorBodyFixture(type, code), status)),
          ).createPayment(PAYMENT_INPUT),
        );

        expect(rejection.kind).toBe(kind);
        expect(rejection.message).not.toContain(SECRET_KEY);
        expect(rejection.message).toContain('(request req_1)');
      },
    );
  });

  describe('refund', () => {
    const postsOf = (fetchFn: FetchMock) =>
      fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST');

    it('reads the session, then refunds its payment intent', async () => {
      const fetchFn = fetchAnswering(
        paidSession(),
        jsonResponse(
          refundFixture({ id: REFUND_ID, payment_intent: PAYMENT_INTENT_ID }),
        ),
      );

      const created = await providerWith(fetchFn).refund(REFUND_INPUT);

      expect(created).toEqual({
        providerRefundId: REFUND_ID,
        status: 'succeeded',
      });
      expectWithinRequestBudget(fetchFn);
      expect(requestOf(fetchFn, 0)).toMatchObject({
        method: 'GET',
        path: `/v1/checkout/sessions/${SESSION_ID}`,
        form: undefined,
      });
      expect(requestOf(fetchFn, 1)).toMatchObject({
        method: 'POST',
        path: '/v1/refunds',
        headers: {
          'Idempotency-Key': `payvolok-refund-${REFUND_INPUT.reference}`,
        },
        form: {
          payment_intent: PAYMENT_INTENT_ID,
          amount: '200',
          'metadata[payvolok_refund_reference]': REFUND_INPUT.reference,
        },
      });
    });

    it.each([
      ['pending', 'pending'],
      ['requires_action', 'pending'],
      ['succeeded', 'succeeded'],
      ['failed', 'failed'],
      ['canceled', 'failed'],
    ])('maps a created %s refund to %s', async (status, refundStatus) => {
      const fetchFn = fetchAnswering(
        paidSession(),
        jsonResponse(refundFixture({ id: REFUND_ID, status })),
      );

      await expect(providerWith(fetchFn).refund(REFUND_INPUT)).resolves.toEqual(
        { providerRefundId: REFUND_ID, status: refundStatus },
      );
    });

    it.each([null, 'reversed'])(
      'treats a created refund with status %s as unavailable',
      async (status) => {
        const fetchFn = fetchAnswering(
          paidSession(),
          jsonResponse(refundFixture({ status })),
        );

        await expect(
          providerWith(fetchFn).refund(REFUND_INPUT),
        ).rejects.toMatchObject({ kind: 'unavailable' });
      },
    );

    it.each([
      ['an unpaid session', createdSession()],
      [
        'a session without a payment intent',
        paidSession({ payment_intent: null }),
      ],
      ['a session in another currency', paidSession({ currency: 'eur' })],
      ['an unknown session', missing()],
    ])('rejects %s without a POST', async (_case, response) => {
      const fetchFn = fetchAnswering(response);

      const rejection = await rejectionOf(
        providerWith(fetchFn).refund(REFUND_INPUT),
      );

      expect(rejection.kind).toBe('rejected');
      expect(postsOf(fetchFn)).toHaveLength(0);
    });

    it('rejects an amount Stripe refuses', async () => {
      const fetchFn = fetchAnswering(
        paidSession(),
        jsonResponse(
          errorBodyFixture('invalid_request_error', 'charge_already_refunded'),
          400,
        ),
      );

      await expect(
        providerWith(fetchFn).refund(REFUND_INPUT),
      ).rejects.toMatchObject({ kind: 'rejected' });
    });

    it.each([
      ['a live session id', { providerPaymentId: 'cs_live_a1Synthetic01' }],
      ['a path in the payment id', { providerPaymentId: 'cs_test_1/../x' }],
      ['a zero amount', { amountMinor: 0 }],
      ['an unsupported currency', { currency: 'GBP' }],
    ])('rejects %s without calling Stripe', async (_case, overrides) => {
      const fetchFn = fetchAnswering();

      const rejection = await rejectionOf(
        providerWith(fetchFn).refund({ ...REFUND_INPUT, ...overrides }),
      );

      expect(rejection.kind).toBe('rejected');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    const paymentQuery = {
      resource: 'payment' as const,
      providerPaymentId: SESSION_ID,
    };

    const expandedSession = (
      status: string,
      paymentStatus: string,
      paymentIntentStatus: string | null,
    ) =>
      jsonResponse(
        sessionFixture({
          id: SESSION_ID,
          status,
          payment_status: paymentStatus,
          amount_subtotal: 700,
          payment_intent:
            paymentIntentStatus === null
              ? null
              : paymentIntentFixture({ status: paymentIntentStatus }),
        }),
      );

    it.each([
      ['open', 'unpaid', null, 'pending'],
      ['complete', 'paid', 'succeeded', 'succeeded'],
      ['complete', 'unpaid', 'requires_payment_method', 'failed'],
      ['complete', 'unpaid', 'canceled', 'failed'],
      ['complete', 'unpaid', 'processing', 'pending'],
      ['complete', 'unpaid', null, 'pending'],
      ['expired', 'unpaid', null, 'expired'],
      ['expired', 'paid', 'succeeded', 'expired'],
    ])(
      'maps a %s/%s session with intent %s to %s',
      async (status, paymentStatus, paymentIntentStatus, paymentResult) => {
        const fetchFn = fetchAnswering(
          expandedSession(status, paymentStatus, paymentIntentStatus),
        );

        await expect(
          providerWith(fetchFn).getStatus(paymentQuery),
        ).resolves.toEqual({
          resource: 'payment',
          providerPaymentId: SESSION_ID,
          status: paymentResult,
          amountMinor: 734,
          currency: 'USD',
        });
        expect(requestOf(fetchFn, 0)).toMatchObject({
          method: 'GET',
          path: `/v1/checkout/sessions/${SESSION_ID}`,
          query: { 'expand[]': 'payment_intent' },
        });
        expectWithinRequestBudget(fetchFn);
      },
    );

    it.each([
      ['an unknown status', expandedSession('processing', 'unpaid', null)],
      [
        'a complete session with no payment required',
        expandedSession('complete', 'no_payment_required', null),
      ],
      ['a session without a total', createdSession({ amount_total: null })],
    ])('treats %s as unavailable', async (_case, response) => {
      const rejection = await rejectionOf(
        providerWith(fetchAnswering(response)).getStatus(paymentQuery),
      );

      expect(rejection.kind).toBe('unavailable');
    });

    it('answers null for a session Stripe does not know', async () => {
      await expect(
        providerWith(fetchAnswering(missing())).getStatus(paymentQuery),
      ).resolves.toBeNull();
    });

    it('does not read a 404 without resource_missing as unknown', async () => {
      const rejection = await rejectionOf(
        providerWith(
          fetchAnswering(new Response('nope', { status: 404 })),
        ).getStatus(paymentQuery),
      );

      expect(rejection.kind).toBe('unavailable');
    });

    it('answers null for an id that is not a test session, calling nothing', async () => {
      const fetchFn = fetchAnswering();

      await expect(
        providerWith(fetchFn).getStatus({
          resource: 'payment',
          providerPaymentId: 'cs_live_a1Synthetic01',
        }),
      ).resolves.toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    });

    const refundQuery = (providerRefundId: string | null) => ({
      resource: 'refund' as const,
      providerPaymentId: SESSION_ID,
      providerRefundId,
      reference: REFUND_INPUT.reference,
    });

    it('reads a refund by its id', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(refundFixture({ id: REFUND_ID, status: 'pending' })),
      );

      await expect(
        providerWith(fetchFn).getStatus(refundQuery(REFUND_ID)),
      ).resolves.toEqual({
        resource: 'refund',
        providerRefundId: REFUND_ID,
        status: 'pending',
        amountMinor: 200,
        currency: 'USD',
      });
      expect(requestOf(fetchFn, 0).path).toBe(`/v1/refunds/${REFUND_ID}`);
    });

    it('answers null for an unknown refund', async () => {
      await expect(
        providerWith(fetchAnswering(missing())).getStatus(
          refundQuery(REFUND_ID),
        ),
      ).resolves.toBeNull();
    });

    it.each([null, 'pyr_1Synthetic', 're_1/../x'])(
      'answers null for the refund id %s, calling nothing',
      async (providerRefundId) => {
        const fetchFn = fetchAnswering();

        await expect(
          providerWith(fetchFn).getStatus(refundQuery(providerRefundId)),
        ).resolves.toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
      },
    );
  });

  describe('listRefunds', () => {
    it('lists the refunds of the session payment intent in one page', async () => {
      const fetchFn = fetchAnswering(
        paidSession(),
        jsonResponse(
          refundListFixture([
            refundFixture({ id: 're_1A', payment_intent: PAYMENT_INTENT_ID }),
            refundFixture({
              id: 're_1B',
              payment_intent: PAYMENT_INTENT_ID,
              status: 'canceled',
              amount: 50,
            }),
          ]),
        ),
      );

      await expect(
        providerWith(fetchFn).listRefunds(SESSION_ID),
      ).resolves.toEqual([
        {
          providerRefundId: 're_1A',
          status: 'succeeded',
          amountMinor: 200,
          currency: 'USD',
        },
        {
          providerRefundId: 're_1B',
          status: 'failed',
          amountMinor: 50,
          currency: 'USD',
        },
      ]);
      expect(requestOf(fetchFn, 1)).toMatchObject({
        method: 'GET',
        path: '/v1/refunds',
        query: { payment_intent: PAYMENT_INTENT_ID, limit: '100' },
      });
      expectWithinRequestBudget(fetchFn);
    });

    it('skips a refund of another payment intent', async () => {
      const fetchFn = fetchAnswering(
        paidSession(),
        jsonResponse(
          refundListFixture([refundFixture({ payment_intent: 'pi_3Other' })]),
        ),
      );

      await expect(
        providerWith(fetchFn).listRefunds(SESSION_ID),
      ).resolves.toEqual([]);
    });

    it('answers no refunds for a session without a payment intent, with one call', async () => {
      const fetchFn = fetchAnswering(createdSession());

      await expect(
        providerWith(fetchFn).listRefunds(SESSION_ID),
      ).resolves.toEqual([]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'a list with more pages',
        refundListFixture(
          [refundFixture({ payment_intent: PAYMENT_INTENT_ID })],
          true,
        ),
      ],
      [
        'a refund status it does not map',
        refundListFixture([
          refundFixture({
            payment_intent: PAYMENT_INTENT_ID,
            status: 'reversed',
          }),
        ]),
      ],
      ['a list that fails the schema', { data: 'none' }],
    ])('treats %s as unavailable', async (_case, body) => {
      const rejection = await rejectionOf(
        providerWith(
          fetchAnswering(paidSession(), jsonResponse(body)),
        ).listRefunds(SESSION_ID),
      );

      expect(rejection.kind).toBe('unavailable');
    });

    it('rejects an id that is not a test session, calling nothing', async () => {
      const fetchFn = fetchAnswering();

      await expect(
        providerWith(fetchFn).listRefunds('cs_test_1/../x'),
      ).rejects.toMatchObject({ kind: 'rejected' });
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('verifyWebhook', () => {
    const body = eventFixture('checkout.session.completed', sessionFixture());

    it('accepts a delivery signed with the secret', async () => {
      await expect(
        providerWith(fetchAnswering()).verifyWebhook(
          signedStripeWebhook(body, WEBHOOK_SECRET, NOW_EPOCH_MS),
        ),
      ).resolves.toBe(true);
    });

    it('refuses a delivery signed with another secret', async () => {
      await expect(
        providerWith(fetchAnswering()).verifyWebhook(
          signedStripeWebhook(body, OTHER_WEBHOOK_SECRET, NOW_EPOCH_MS),
        ),
      ).resolves.toBe(false);
    });

    it('accepts a delivery signed with only the second of two secrets', async () => {
      const provider = providerWith(fetchAnswering(), {
        webhookSecrets: [
          new RedactedSecret(OTHER_WEBHOOK_SECRET),
          new RedactedSecret(WEBHOOK_SECRET),
        ],
      });

      await expect(
        provider.verifyWebhook(
          signedStripeWebhook(body, WEBHOOK_SECRET, NOW_EPOCH_MS),
        ),
      ).resolves.toBe(true);
    });

    it('rejects when no secret is configured, so the delivery gets a 503', async () => {
      const rejection = await rejectionOf(
        providerWith(fetchAnswering(), { webhookSecrets: [] }).verifyWebhook(
          signedStripeWebhook(body, WEBHOOK_SECRET, NOW_EPOCH_MS),
        ),
      );

      expect(rejection.kind).toBe('misconfigured');
    });
  });

  describe('parseWebhook', () => {
    const provider = providerWith(fetchAnswering());

    const parse = (body: unknown) =>
      provider.parseWebhook(
        signedStripeWebhook(body, WEBHOOK_SECRET, NOW_EPOCH_MS),
      );

    const sessionEvent = (
      type: string,
      overrides: Partial<StripeSessionFixture> = {},
    ) =>
      eventFixture(
        type,
        sessionFixture({ id: SESSION_ID, amount_subtotal: 700, ...overrides }),
        { id: 'evt_1SyntheticEvent0001' },
      );

    it('maps a paid checkout.session.completed to payment.succeeded', () => {
      expect(
        parse(
          sessionEvent('checkout.session.completed', {
            status: 'complete',
            payment_status: 'paid',
          }),
        ),
      ).toEqual([
        {
          type: 'payment.succeeded',
          dedupKey: 'evt_1SyntheticEvent0001',
          occurredAt: '2025-11-11T10:00:00.000Z',
          purpose: 'one_off',
          reference: REFERENCE,
          providerPaymentId: SESSION_ID,
          providerSubscriptionId: null,
          amountMinor: 734,
          currency: 'USD',
          failureReason: null,
        },
      ]);
    });

    it.each([
      ['checkout.session.completed', 'unpaid', 'payment.pending', null],
      [
        'checkout.session.async_payment_succeeded',
        'paid',
        'payment.succeeded',
        null,
      ],
      [
        'checkout.session.async_payment_failed',
        'unpaid',
        'payment.failed',
        'stripe_async_payment_failed',
      ],
      ['checkout.session.expired', 'unpaid', 'payment.expired', null],
    ])(
      'maps %s with %s to %s',
      (eventType, paymentStatus, type, failureReason) => {
        expect(
          parse(sessionEvent(eventType, { payment_status: paymentStatus })),
        ).toEqual([
          expect.objectContaining({
            type,
            providerPaymentId: SESSION_ID,
            failureReason,
          }),
        ]);
      },
    );

    it.each([
      [
        'a completed session that needs no payment',
        sessionEvent('checkout.session.completed', {
          payment_status: 'no_payment_required',
        }),
      ],
      [
        'a live event',
        {
          ...sessionEvent('checkout.session.completed', {
            payment_status: 'paid',
          }),
          livemode: true,
        },
      ],
      [
        'a live session',
        sessionEvent('checkout.session.completed', {
          payment_status: 'paid',
          livemode: true,
        }),
      ],
      [
        'a subscription session',
        sessionEvent('checkout.session.completed', {
          payment_status: 'paid',
          mode: 'subscription',
        }),
      ],
      [
        'a live session id',
        sessionEvent('checkout.session.completed', {
          payment_status: 'paid',
          id: 'cs_live_a1Synthetic0001',
        }),
      ],
      [
        'a session without a total',
        sessionEvent('checkout.session.expired', { amount_total: null }),
      ],
      [
        'a session without a currency',
        sessionEvent('checkout.session.expired', { currency: null }),
      ],
      [
        'a session with a four-letter currency',
        sessionEvent('checkout.session.expired', { currency: 'usdt' }),
      ],
      [
        'a refund event',
        eventFixture(
          'refund.updated',
          refundFixture({ payment_intent: PAYMENT_INTENT_ID }),
        ),
      ],
      [
        'a charge event',
        eventFixture('charge.refunded', { id: 'ch_1', object: 'charge' }),
      ],
      [
        'a payment intent event',
        eventFixture(
          'payment_intent.payment_failed',
          paymentIntentFixture({ status: 'requires_payment_method' }),
        ),
      ],
    ])('leaves %s unknown with its raw type', (_case, body) => {
      expect(parse(body)).toEqual([
        {
          type: 'unknown',
          rawType: body.type,
          dedupKey: body.id,
          occurredAt: '2025-11-11T10:00:00.000Z',
        },
      ]);
    });

    it('reads the total, not the subtotal, and upper-cases the currency', () => {
      expect(
        parse(
          sessionEvent('checkout.session.expired', {
            amount_total: 735,
            amount_subtotal: 734,
            currency: 'eur',
          }),
        ),
      ).toEqual([
        expect.objectContaining({ amountMinor: 735, currency: 'EUR' }),
      ]);
    });

    it('reads a missing client_reference_id as a null reference', () => {
      expect(
        parse(
          sessionEvent('checkout.session.expired', {
            client_reference_id: null,
          }),
        ),
      ).toEqual([expect.objectContaining({ reference: null })]);
    });

    describe('never throws', () => {
      const unknownFrom = (rawBody: Buffer) =>
        provider.parseWebhook({ rawBody, headers: {} });

      it('answers a non-JSON body with one unknown event keyed by a stable body hash', () => {
        const rawBody = Buffer.from([0xff, 0x00, 0x7b]);

        const [first] = unknownFrom(rawBody);
        const [second] = unknownFrom(rawBody);

        expect(first).toEqual({
          type: 'unknown',
          rawType: null,
          dedupKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as string,
          occurredAt: null,
        });
        expect(second.dedupKey).toBe(first.dedupKey);
      });

      it.each([
        ['{}', {}],
        ['an id that is not an event', { ...sessionEvent('x'), id: 'cs_1' }],
        ['a fractional created', { ...sessionEvent('x'), created: 1.5 }],
      ])('answers %s with one unknown event without a type', (_case, body) => {
        expect(unknownFrom(Buffer.from(JSON.stringify(body)))).toEqual([
          expect.objectContaining({ type: 'unknown', rawType: null }),
        ]);
      });

      it.each(['constructor', '__proto__', 'toString'])(
        'leaves the event type %s unknown',
        (eventType) => {
          expect(parse(sessionEvent(eventType))).toEqual([
            expect.objectContaining({ type: 'unknown', rawType: eventType }),
          ]);
        },
      );
    });
  });
});
