import { ProviderError, type RefundInput } from '../payment-provider.port';

import {
  adjustmentEventFixture,
  adjustmentListFixture,
  adjustmentResponseFixture,
  errorBodyFixture,
  forbiddenHtmlFixture,
  signedPaddleWebhook,
  transactionEventFixture,
  transactionResponseFixture,
  type ErrorBodyName,
} from './fixtures/paddle-fixtures';
import { PaddleProvider } from './paddle.provider';

type FetchMock = jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

const API_KEY = `pdl_sdbx_apikey_${'k'.repeat(53)}`;
const WEBHOOK_SECRET = 'pdl_ntfset_01jcsyntheticsecret00000001_AbCdEf';
const NOW_MS = 1_762_855_200_000;
const TRANSACTION_ID = 'txn_01jcsyntheticpayment000001';
const LINE_ITEM_ID = 'txnitm_01jcsyntheticlineitem00001';
const ADJUSTMENT_ID = 'adj_01jcsyntheticrefund0000001';
const REFERENCE = '5b0b3a0e-6f0c-4c43-9d5e-0a8a7d5e1c11';
const CHECKOUT_URL = `https://payvolok.example.test/checkout/paddle?_ptxn=${TRANSACTION_ID}`;

const PAYMENT_INPUT = {
  reference: REFERENCE,
  amountMinor: 1000,
  currency: 'USD',
  description: 'e2e order',
  returnUrl: 'https://shop.example.test/return',
  webhookUrl: 'https://payvolok.example.test/webhooks/paddle',
};

const REFUND_INPUT: RefundInput = {
  reference: '8c6f9a52-0d6c-4c8e-9a7b-1f2e3d4c5b6a',
  providerPaymentId: TRANSACTION_ID,
  amountMinor: 400,
  currency: 'USD',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetchAnswering = (...responses: Response[]): FetchMock => {
  const queue = [...responses];

  return jest.fn<Promise<Response>, Parameters<typeof fetch>>(() => {
    const response = queue.shift();
    if (!response) throw new Error('Unexpected Paddle request');

    return Promise.resolve(response);
  });
};

const providerWith = (
  fetchFn: FetchMock,
  config: Partial<ConstructorParameters<typeof PaddleProvider>[0]> = {},
): PaddleProvider =>
  new PaddleProvider(
    { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, ...config },
    fetchFn,
    () => NOW_MS,
  );

const requestOf = (fetchFn: FetchMock, index: number) => {
  const [url, init] = fetchFn.mock.calls[index];

  return {
    url,
    method: init?.method,
    body:
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : undefined,
  };
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

const createdTransaction = () =>
  transactionResponseFixture('transaction-created');

// JSON.stringify drops an undefined checkout, which is how "no checkout" is sent.
const createdTransactionWithCheckout = (checkout: unknown) => {
  const fixture = createdTransaction();

  return { ...fixture, data: { ...fixture.data, checkout } };
};

const completedTransaction = () =>
  transactionResponseFixture('transaction-completed');

const adjustmentWithStatus = (status: string) => {
  const fixture = adjustmentResponseFixture();
  fixture.data.status = status;

  return fixture;
};

const parse = (provider: PaddleProvider, body: unknown) =>
  provider.parseWebhook(signedPaddleWebhook(body, WEBHOOK_SECRET, NOW_MS));

describe('PaddleProvider', () => {
  it('declares provider refund identity and the signature header', () => {
    const provider = providerWith(fetchAnswering());

    expect(provider.code).toBe('paddle');
    expect(provider.capabilities).toEqual({
      recurring: 'managed',
      intervals: [],
      partialRefund: true,
      catalog: true,
      refundIdentity: 'provider',
    });
    expect(provider.webhookHeaders).toEqual(['paddle-signature']);
  });

  describe('createPayment', () => {
    it('sends one POST with the designed body and returns the checkout url', async () => {
      const fetchFn = fetchAnswering(jsonResponse(createdTransaction(), 201));

      const created = await providerWith(fetchFn).createPayment(PAYMENT_INPUT);

      expect(created).toEqual({
        providerPaymentId: TRANSACTION_ID,
        redirectUrl: CHECKOUT_URL,
        status: 'pending',
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('https://sandbox-api.paddle.com/transactions');
      expect(init).toMatchObject({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Paddle-Version': '1',
        },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(requestOf(fetchFn, 0).body).toEqual({
        items: [
          {
            quantity: 1,
            price: {
              description: 'e2e order',
              unit_price: { amount: '1000', currency_code: 'USD' },
              tax_mode: 'internal',
              product: { name: 'e2e order', tax_category: 'standard' },
            },
          },
        ],
        currency_code: 'USD',
        custom_data: { reference: REFERENCE },
      });
    });

    it('cuts the product name to 200 characters', async () => {
      const fetchFn = fetchAnswering(jsonResponse(createdTransaction(), 201));
      const description = 'd'.repeat(255);

      await providerWith(fetchFn).createPayment({
        ...PAYMENT_INPUT,
        description,
      });

      expect(requestOf(fetchFn, 0).body).toMatchObject({
        items: [
          {
            price: {
              description,
              product: { name: 'd'.repeat(200) },
            },
          },
        ],
      });
    });

    it.each([
      ['a null checkout url', { url: null }, 'misconfigured'],
      ['a null checkout', null, 'misconfigured'],
      ['no checkout', undefined, 'misconfigured'],
      [
        'an http checkout url',
        { url: 'http://payvolok.example.test/pay' },
        'unavailable',
      ],
      ['a checkout url that is not a url', { url: 'pay here' }, 'unavailable'],
    ])('answers %s as %s', async (_case, checkout, kind) => {
      const fetchFn = fetchAnswering(
        jsonResponse(createdTransactionWithCheckout(checkout), 201),
      );

      const rejection = await rejectionOf(
        providerWith(fetchFn).createPayment(PAYMENT_INPUT),
      );

      expect(rejection.kind).toBe(kind);
    });

    it.each([
      ['a zero amount', { amountMinor: 0 }],
      ['a negative amount', { amountMinor: -1 }],
      ['a fractional amount', { amountMinor: 10.5 }],
      ['an unsafe amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
      ['a lowercase currency', { currency: 'usd' }],
      ['a two-letter currency', { currency: 'US' }],
    ])('rejects %s without calling Paddle', async (_case, overrides) => {
      const fetchFn = fetchAnswering();

      const rejection = await rejectionOf(
        providerWith(fetchFn).createPayment({ ...PAYMENT_INPUT, ...overrides }),
      );

      expect(rejection.kind).toBe('rejected');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('is misconfigured without an API key and calls nothing', async () => {
      const fetchFn = fetchAnswering();

      const rejection = await rejectionOf(
        providerWith(fetchFn, { apiKey: null }).createPayment(PAYMENT_INPUT),
      );

      expect(rejection.kind).toBe('misconfigured');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    describe('error classification', () => {
      it.each<[number, ErrorBodyName, string]>([
        [400, 'invalid_field', 'rejected'],
        [400, 'transaction_default_checkout_url_not_set', 'misconfigured'],
        [401, 'invalid_token', 'misconfigured'],
        [403, 'forbidden', 'misconfigured'],
        [404, 'not_found', 'rejected'],
        [429, 'too_many_requests', 'unavailable'],
        [500, 'internal_error', 'unavailable'],
      ])('maps %i %s to %s', async (status, name, kind) => {
        const fetchFn = fetchAnswering(
          jsonResponse(errorBodyFixture(name), status),
        );

        const rejection = await rejectionOf(
          providerWith(fetchFn).createPayment(PAYMENT_INPUT),
        );

        expect(rejection.kind).toBe(kind);
        expect(rejection.message).not.toContain(API_KEY);
      });

      it('maps an HTML 403 to unavailable', async () => {
        const fetchFn = fetchAnswering(
          new Response(forbiddenHtmlFixture(), {
            status: 403,
            headers: { 'content-type': 'text/html' },
          }),
        );

        const rejection = await rejectionOf(
          providerWith(fetchFn).createPayment(PAYMENT_INPUT),
        );

        expect(rejection.kind).toBe('unavailable');
      });

      it('maps a 201 that fails the schema to unavailable', async () => {
        const fixture = createdTransaction();
        const fetchFn = fetchAnswering(
          jsonResponse(
            { ...fixture, data: { ...fixture.data, id: 'txn_1' } },
            201,
          ),
        );

        const rejection = await rejectionOf(
          providerWith(fetchFn).createPayment(PAYMENT_INPUT),
        );

        expect(rejection.kind).toBe('unavailable');
      });

      it('maps a thrown fetch to unavailable', async () => {
        const fetchFn = jest.fn<Promise<Response>, Parameters<typeof fetch>>(
          () => Promise.reject(new TypeError('fetch failed')),
        );

        const rejection = await rejectionOf(
          providerWith(fetchFn).createPayment(PAYMENT_INPUT),
        );

        expect(rejection.kind).toBe('unavailable');
      });
    });
  });

  describe('refund', () => {
    const refundAdjustmentsPage = (
      adjustments: { status: string; total: string }[] = [],
      hasMore = false,
    ) => {
      const fixture = adjustmentListFixture();
      const [template] = fixture.data;

      return jsonResponse({
        ...fixture,
        data: adjustments.map(({ status, total }, index) => ({
          ...template,
          id: `adj_01jcsyntheticrefund000000${index + 2}`,
          status,
          totals: { ...template.totals, total },
        })),
        meta: {
          ...fixture.meta,
          pagination: { ...fixture.meta.pagination, has_more: hasMore },
        },
      });
    };

    const postsOf = (fetchFn: FetchMock) =>
      fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST');

    it('reads the transaction and its refunds, then refunds it in full when nothing was refunded', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        refundAdjustmentsPage(),
        jsonResponse(adjustmentResponseFixture(), 201),
      );

      const created = await providerWith(fetchFn).refund({
        ...REFUND_INPUT,
        amountMinor: 1000,
      });

      expect(created).toEqual({
        providerRefundId: ADJUSTMENT_ID,
        status: 'pending',
      });
      expect(requestOf(fetchFn, 0)).toEqual({
        url: `https://sandbox-api.paddle.com/transactions/${TRANSACTION_ID}`,
        method: 'GET',
        body: undefined,
      });
      expect(requestOf(fetchFn, 1)).toEqual({
        url: `https://sandbox-api.paddle.com/adjustments?transaction_id=${TRANSACTION_ID}&action=refund&per_page=50`,
        method: 'GET',
        body: undefined,
      });
      expect(requestOf(fetchFn, 2)).toEqual({
        url: 'https://sandbox-api.paddle.com/adjustments',
        method: 'POST',
        body: {
          action: 'refund',
          type: 'full',
          transaction_id: TRANSACTION_ID,
          reason: 'api_refund',
        },
      });
    });

    it('refunds part of the only line item', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        refundAdjustmentsPage(),
        jsonResponse(adjustmentResponseFixture(), 201),
      );

      await providerWith(fetchFn).refund(REFUND_INPUT);

      expect(requestOf(fetchFn, 2).body).toEqual({
        action: 'refund',
        type: 'partial',
        tax_mode: 'internal',
        transaction_id: TRANSACTION_ID,
        reason: 'api_refund',
        items: [{ item_id: LINE_ITEM_ID, type: 'partial', amount: '400' }],
      });
    });

    it('rejects a retry for an amount a pending refund already holds, without a POST', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        refundAdjustmentsPage([{ status: 'pending_approval', total: '600' }]),
      );

      const rejection = await rejectionOf(
        providerWith(fetchFn).refund({ ...REFUND_INPUT, amountMinor: 600 }),
      );

      expect(rejection.kind).toBe('rejected');
      expect(postsOf(fetchFn)).toHaveLength(0);
    });

    it('refunds the rest partially after a pending refund', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        refundAdjustmentsPage([{ status: 'pending_approval', total: '600' }]),
        jsonResponse(adjustmentResponseFixture(), 201),
      );

      await providerWith(fetchFn).refund({ ...REFUND_INPUT, amountMinor: 400 });

      expect(requestOf(fetchFn, 2).body).toMatchObject({
        type: 'partial',
        items: [{ item_id: LINE_ITEM_ID, type: 'partial', amount: '400' }],
      });
    });

    it('counts approved refunds and ignores rejected ones', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        refundAdjustmentsPage([
          { status: 'approved', total: '300' },
          { status: 'rejected', total: '700' },
          { status: 'pending_approval', total: '300' },
        ]),
        jsonResponse(adjustmentResponseFixture(), 201),
      );

      await expect(
        providerWith(fetchFn).refund({ ...REFUND_INPUT, amountMinor: 401 }),
      ).rejects.toMatchObject({ kind: 'rejected' });
      expect(postsOf(fetchFn)).toHaveLength(0);
    });

    it.each([
      ['a failed list', jsonResponse(errorBodyFixture('internal_error'), 500)],
      ['a list with more pages', refundAdjustmentsPage([], true)],
      ['a list that fails the schema', jsonResponse({ data: 'none' })],
    ])('treats %s as unavailable without a POST', async (_case, response) => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        response,
      );

      const rejection = await rejectionOf(
        providerWith(fetchFn).refund(REFUND_INPUT),
      );

      expect(rejection.kind).toBe('unavailable');
      expect(postsOf(fetchFn)).toHaveLength(0);
    });

    it.each([
      ['pending_approval', 'pending'],
      ['approved', 'succeeded'],
      ['rejected', 'failed'],
    ])('maps a created %s adjustment to %s', async (status, refundStatus) => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        refundAdjustmentsPage(),
        jsonResponse(adjustmentWithStatus(status), 201),
      );

      await expect(providerWith(fetchFn).refund(REFUND_INPUT)).resolves.toEqual(
        {
          providerRefundId: ADJUSTMENT_ID,
          status: refundStatus,
        },
      );
    });

    it('treats an adjustment status it does not know as unavailable', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(completedTransaction()),
        refundAdjustmentsPage(),
        jsonResponse(adjustmentWithStatus('reversed'), 201),
      );

      const rejection = await rejectionOf(
        providerWith(fetchFn).refund(REFUND_INPUT),
      );

      expect(rejection.kind).toBe('unavailable');
    });

    const transactionWith = (
      change: (data: ReturnType<typeof completedTransaction>['data']) => void,
    ) => {
      const fixture = completedTransaction();
      change(fixture.data);

      return jsonResponse(fixture);
    };

    it.each([
      [
        'a transaction that is not completed',
        transactionWith((data) => {
          data.status = 'paid';
        }),
      ],
      [
        'another currency',
        transactionWith((data) => {
          data.currency_code = 'EUR';
        }),
      ],
      [
        'a partial refund of two line items',
        transactionWith((data) => {
          data.details.line_items.push({
            id: 'txnitm_01jcsyntheticlineitem00002',
          });
        }),
      ],
      [
        'an unknown transaction',
        jsonResponse(errorBodyFixture('not_found'), 404),
      ],
    ])('rejects %s without creating an adjustment', async (_case, response) => {
      const fetchFn = fetchAnswering(response, refundAdjustmentsPage());

      const rejection = await rejectionOf(
        providerWith(fetchFn).refund(REFUND_INPUT),
      );

      expect(rejection.kind).toBe('rejected');
      expect(postsOf(fetchFn)).toHaveLength(0);
    });

    it.each([
      [
        'a payment id that is not a transaction',
        { providerPaymentId: '../customers' },
      ],
      ['a zero amount', { amountMinor: 0 }],
      ['a lowercase currency', { currency: 'usd' }],
    ])('rejects %s without calling Paddle', async (_case, overrides) => {
      const fetchFn = fetchAnswering();

      const rejection = await rejectionOf(
        providerWith(fetchFn).refund({ ...REFUND_INPUT, ...overrides }),
      );

      expect(rejection.kind).toBe('rejected');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    const transactionInStatus = (status: string) => {
      const fixture = completedTransaction();
      fixture.data.status = status;
      fixture.data.details.totals.grand_total = '900';

      return jsonResponse(fixture);
    };

    it.each([
      ['draft', 'pending'],
      ['ready', 'pending'],
      ['billed', 'pending'],
      ['paid', 'pending'],
      ['past_due', 'pending'],
      ['completed', 'succeeded'],
      ['canceled', 'failed'],
    ])(
      'maps a %s transaction to %s with its total',
      async (status, paymentStatus) => {
        const fetchFn = fetchAnswering(transactionInStatus(status));

        await expect(
          providerWith(fetchFn).getStatus({
            resource: 'payment',
            providerPaymentId: TRANSACTION_ID,
          }),
        ).resolves.toEqual({
          resource: 'payment',
          providerPaymentId: TRANSACTION_ID,
          status: paymentStatus,
          amountMinor: 1000,
          currency: 'USD',
        });
        expect(requestOf(fetchFn, 0).url).toBe(
          `https://sandbox-api.paddle.com/transactions/${TRANSACTION_ID}`,
        );
      },
    );

    it('treats a transaction status it does not know as unavailable', async () => {
      const fetchFn = fetchAnswering(transactionInStatus('refunded'));

      const rejection = await rejectionOf(
        providerWith(fetchFn).getStatus({
          resource: 'payment',
          providerPaymentId: TRANSACTION_ID,
        }),
      );

      expect(rejection.kind).toBe('unavailable');
    });

    it('answers null for an unknown transaction', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse(errorBodyFixture('not_found'), 404),
      );

      await expect(
        providerWith(fetchFn).getStatus({
          resource: 'payment',
          providerPaymentId: TRANSACTION_ID,
        }),
      ).resolves.toBeNull();
    });

    it('answers null for a payment id that is not a transaction, calling nothing', async () => {
      const fetchFn = fetchAnswering();

      await expect(
        providerWith(fetchFn).getStatus({
          resource: 'payment',
          providerPaymentId: 'txn_1/../../customers',
        }),
      ).resolves.toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    });

    const refundQuery = (providerRefundId: string | null) => ({
      resource: 'refund' as const,
      providerPaymentId: TRANSACTION_ID,
      providerRefundId,
      reference: REFUND_INPUT.reference,
    });

    it('answers null for a refund without a provider id, calling nothing', async () => {
      const fetchFn = fetchAnswering();

      await expect(
        providerWith(fetchFn).getStatus(refundQuery(null)),
      ).resolves.toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('lists the adjustment by id and transaction', async () => {
      const fetchFn = fetchAnswering(jsonResponse(adjustmentListFixture()));

      await expect(
        providerWith(fetchFn).getStatus(refundQuery(ADJUSTMENT_ID)),
      ).resolves.toEqual({
        resource: 'refund',
        providerRefundId: ADJUSTMENT_ID,
        status: 'succeeded',
        amountMinor: 400,
        currency: 'USD',
      });
      expect(requestOf(fetchFn, 0).url).toBe(
        `https://sandbox-api.paddle.com/adjustments?id=${ADJUSTMENT_ID}&transaction_id=${TRANSACTION_ID}`,
      );
    });

    it('answers null for an empty adjustment list', async () => {
      const fetchFn = fetchAnswering(
        jsonResponse({ ...adjustmentListFixture(), data: [] }),
      );

      await expect(
        providerWith(fetchFn).getStatus(refundQuery(ADJUSTMENT_ID)),
      ).resolves.toBeNull();
    });
  });

  describe('verifyWebhook', () => {
    const body = transactionEventFixture('event-transaction-completed');

    it('accepts a delivery signed with the secret', async () => {
      await expect(
        providerWith(fetchAnswering()).verifyWebhook(
          signedPaddleWebhook(body, WEBHOOK_SECRET, NOW_MS),
        ),
      ).resolves.toBe(true);
    });

    it('refuses a delivery signed with another secret', async () => {
      await expect(
        providerWith(fetchAnswering()).verifyWebhook(
          signedPaddleWebhook(body, 'pdl_ntfset_other', NOW_MS),
        ),
      ).resolves.toBe(false);
    });

    it('rejects when no secret is configured, so the delivery gets a 503', async () => {
      const rejection = await rejectionOf(
        providerWith(fetchAnswering(), { webhookSecret: null }).verifyWebhook(
          signedPaddleWebhook(body, WEBHOOK_SECRET, NOW_MS),
        ),
      );

      expect(rejection.kind).toBe('misconfigured');
    });
  });

  describe('parseWebhook', () => {
    const provider = providerWith(fetchAnswering());

    it('maps transaction.completed to payment.succeeded', () => {
      expect(
        parse(provider, transactionEventFixture('event-transaction-completed')),
      ).toEqual([
        {
          type: 'payment.succeeded',
          dedupKey: 'evt_01jcsyntheticevent00000001',
          occurredAt: '2026-11-11T10:02:10.123456Z',
          purpose: 'one_off',
          reference: REFERENCE,
          providerPaymentId: TRANSACTION_ID,
          providerSubscriptionId: null,
          amountMinor: 1000,
          currency: 'USD',
          failureReason: null,
        },
      ]);
    });

    it('maps transaction.payment_failed to an attempt failure with the newest error code', () => {
      expect(
        parse(
          provider,
          transactionEventFixture('event-transaction-payment-failed'),
        ),
      ).toEqual([
        expect.objectContaining({
          type: 'payment.attempt_failed',
          dedupKey: 'evt_01jcsyntheticevent00000002',
          providerPaymentId: TRANSACTION_ID,
          failureReason: 'declined',
        }),
      ]);
    });

    it('falls back to a generic reason when no attempt has an error code', () => {
      const body = transactionEventFixture('event-transaction-payment-failed');
      body.data.payments = [];

      expect(parse(provider, body)).toEqual([
        expect.objectContaining({
          type: 'payment.attempt_failed',
          failureReason: 'paddle_payment_failed',
        }),
      ]);
    });

    it('maps transaction.canceled to payment.failed', () => {
      expect(
        parse(provider, transactionEventFixture('event-transaction-canceled')),
      ).toEqual([
        expect.objectContaining({
          type: 'payment.failed',
          failureReason: 'paddle_canceled',
        }),
      ]);
    });

    it('leaves transaction.paid unknown with its raw type', () => {
      expect(
        parse(provider, transactionEventFixture('event-transaction-paid')),
      ).toEqual([
        {
          type: 'unknown',
          rawType: 'transaction.paid',
          dedupKey: 'evt_01jcsyntheticevent00000004',
          occurredAt: '2026-11-11T10:02:06.000000Z',
        },
      ]);
    });

    it('leaves a subscription transaction unknown', () => {
      const body = transactionEventFixture('event-transaction-completed');
      body.data.subscription_id = 'sub_01jcsyntheticsubscription';

      expect(parse(provider, body)).toEqual([
        expect.objectContaining({
          type: 'unknown',
          rawType: 'transaction.completed',
        }),
      ]);
    });

    it.each([
      ['no custom data', null],
      ['a non-string reference', { reference: 42 }],
    ])('reads %s as a null reference', (_case, customData) => {
      const body = transactionEventFixture('event-transaction-completed');
      body.data.custom_data = customData;

      expect(parse(provider, body)).toEqual([
        expect.objectContaining({ type: 'payment.succeeded', reference: null }),
      ]);
    });

    it.each([
      ['event-adjustment-created', 'refund.pending'],
      ['event-adjustment-updated-approved', 'refund.succeeded'],
      ['event-adjustment-updated-rejected', 'refund.failed'],
    ] as const)('maps %s to %s under one refund id', (name, type) => {
      const body = adjustmentEventFixture(name);

      expect(parse(provider, body)).toEqual([
        {
          type,
          dedupKey: body.event_id,
          occurredAt: body.occurred_at,
          providerPaymentId: TRANSACTION_ID,
          reference: null,
          refundReference: null,
          providerRefundId: ADJUSTMENT_ID,
          amountMinor: 400,
          currency: 'USD',
        },
      ]);
    });

    it('reads the refund status from the adjustment, not from the event type', () => {
      const created = adjustmentEventFixture('event-adjustment-created');
      created.data.status = 'approved';
      const updated = adjustmentEventFixture(
        'event-adjustment-updated-approved',
      );
      updated.data.status = 'pending_approval';

      expect(parse(provider, created)[0].type).toBe('refund.succeeded');
      expect(parse(provider, updated)[0].type).toBe('refund.pending');
    });

    it.each([
      [
        'a credit',
        (data: { action: string; status: string }) => {
          data.action = 'credit';
        },
      ],
      [
        'a chargeback',
        (data: { action: string; status: string }) => {
          data.action = 'chargeback';
        },
      ],
      [
        'a reversed refund',
        (data: { action: string; status: string }) => {
          data.status = 'reversed';
        },
      ],
    ])('leaves %s unknown', (_case, change) => {
      const body = adjustmentEventFixture('event-adjustment-updated-approved');
      change(body.data);

      expect(parse(provider, body)).toEqual([
        expect.objectContaining({
          type: 'unknown',
          rawType: 'adjustment.updated',
        }),
      ]);
    });

    it('leaves a subscription adjustment unknown', () => {
      const body = adjustmentEventFixture('event-adjustment-updated-approved');
      body.data.subscription_id = 'sub_01jcsyntheticsubscription';

      expect(parse(provider, body)[0].type).toBe('unknown');
    });

    describe('never throws', () => {
      const unknownFrom = (rawBody: Buffer) =>
        provider.parseWebhook({ rawBody, headers: {} });

      it('answers a non-JSON body with one unknown event keyed by a stable body hash', () => {
        const rawBody = Buffer.from([0xff, 0x00, 0x7b]);

        const [first] = unknownFrom(rawBody);
        const [second] = unknownFrom(rawBody);

        expect(unknownFrom(rawBody)).toHaveLength(1);
        expect(first).toEqual({
          type: 'unknown',
          rawType: null,
          dedupKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as string,
          occurredAt: null,
        });
        expect(second.dedupKey).toBe(first.dedupKey);
      });

      it('answers {} with one unknown event', () => {
        expect(unknownFrom(Buffer.from('{}'))).toEqual([
          expect.objectContaining({ type: 'unknown', rawType: null }),
        ]);
      });

      const completedWith = (
        change: (
          data: Record<string, unknown> & {
            details: { totals: { total: string } };
          },
        ) => void,
      ) => {
        const body = transactionEventFixture('event-transaction-completed');
        change(body.data);

        return body;
      };

      it.each([
        [
          'a fractional amount',
          completedWith((data) => {
            data.details.totals.total = '12.5';
          }),
        ],
        [
          'an amount with a sign',
          completedWith((data) => {
            data.details.totals.total = '-12';
          }),
        ],
        [
          'an unsafe amount',
          completedWith((data) => {
            data.details.totals.total = '9007199254740993';
          }),
        ],
        [
          'a lowercase currency',
          completedWith((data) => {
            data.currency_code = 'usd';
          }),
        ],
        [
          'a missing id',
          completedWith((data) => {
            delete data.id;
          }),
        ],
      ])('answers a known type with %s as one unknown event', (_case, body) => {
        expect(parse(provider, body)).toEqual([
          {
            type: 'unknown',
            rawType: 'transaction.completed',
            dedupKey: 'evt_01jcsyntheticevent00000001',
            occurredAt: '2026-11-11T10:02:10.123456Z',
          },
        ]);
      });

      it.each(['constructor', '__proto__', 'toString'])(
        'leaves the event type %s unknown',
        (eventType) => {
          const body = transactionEventFixture('event-transaction-completed');
          body.event_type = eventType;

          expect(parse(provider, body)).toEqual([
            expect.objectContaining({ type: 'unknown', rawType: eventType }),
          ]);
        },
      );

      it('reads an invalid occurred_at as null', () => {
        const body = transactionEventFixture('event-transaction-completed');
        body.occurred_at = 'yesterday';

        expect(parse(provider, body)[0].occurredAt).toBeNull();
      });
    });
  });
});
