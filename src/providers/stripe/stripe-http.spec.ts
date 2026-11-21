import { inspect } from 'node:util';

import { IDEMPOTENCY_LEASE_SECONDS } from '@/idempotency/idempotency.constants';

import { ProviderError } from '../payment-provider.port';
import { RedactedSecret } from '../provider-credentials';

import { errorBodyFixture } from './fixtures/stripe-fixtures';
import {
  formBodyOf,
  sendStripeRequest,
  STRIPE_API_VERSION,
  STRIPE_MAX_REQUESTS_PER_CALL,
  STRIPE_REQUEST_TIMEOUT_MS,
  stripeErrorOf,
} from './stripe-http';

type FetchMock = jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

const SECRET_KEY = `sk_test_${'Key0'.repeat(24)}`;
const SECRET = new RedactedSecret(SECRET_KEY);
const REQUEST_ID = 'req_SyntheticRequest01';
const HTML_BODY = '<html><body>Bad gateway</body></html>';

const fetchAnswering = (response: Response): FetchMock =>
  jest.fn<Promise<Response>, Parameters<typeof fetch>>(() =>
    Promise.resolve(response),
  );

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

const errorOf = (status: number, body: unknown) =>
  stripeErrorOf({ status, body, requestId: REQUEST_ID });

describe('stripe http', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('timeout budget', () => {
    it('keeps every request of one call under half the idempotency lease', () => {
      expect(
        STRIPE_REQUEST_TIMEOUT_MS * STRIPE_MAX_REQUESTS_PER_CALL,
      ).toBeLessThan((IDEMPOTENCY_LEASE_SECONDS * 1000) / 2);
    });
  });

  describe('formBodyOf', () => {
    it('encodes nested objects and arrays with brackets', () => {
      const params = new URLSearchParams(
        formBodyOf({
          mode: 'payment',
          line_items: [{ quantity: 1, price_data: { unit_amount: 734 } }],
          adaptive_pricing: { enabled: false },
        }),
      );

      expect([...params.entries()]).toEqual([
        ['mode', 'payment'],
        ['line_items[0][quantity]', '1'],
        ['line_items[0][price_data][unit_amount]', '734'],
        ['adaptive_pricing[enabled]', 'false'],
      ]);
    });

    it('escapes the separators inside values', () => {
      expect(formBodyOf({ name: 'a&b=c' })).toBe('name=a%26b%3Dc');
    });
  });

  describe('sendStripeRequest', () => {
    it('sends the key, the pinned version, the idempotency key and a form body', async () => {
      const fetchFn = fetchAnswering(
        new Response('{"id":"cs_test_1"}', {
          status: 200,
          headers: { 'request-id': REQUEST_ID },
        }),
      );

      const response = await sendStripeRequest(fetchFn, SECRET, {
        method: 'POST',
        path: '/v1/checkout/sessions',
        form: { mode: 'payment' },
        idempotencyKey: 'payvolok-payment-1',
      });

      expect(response).toEqual({
        status: 200,
        body: { id: 'cs_test_1' },
        requestId: REQUEST_ID,
      });
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(init).toMatchObject({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SECRET_KEY}`,
          'Stripe-Version': STRIPE_API_VERSION,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': 'payvolok-payment-1',
        },
        body: 'mode=payment',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('sends a GET with an encoded query, no body and no idempotency key', async () => {
      const fetchFn = fetchAnswering(new Response('{}'));

      await sendStripeRequest(fetchFn, SECRET, {
        method: 'GET',
        path: '/v1/refunds',
        query: { payment_intent: 'pi_1&x=y', 'expand[]': 'payment_intent' },
      });

      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe(
        'https://api.stripe.com/v1/refunds?payment_intent=pi_1%26x%3Dy&expand%5B%5D=payment_intent',
      );
      expect(init?.body).toBeUndefined();
      expect(init?.headers).not.toHaveProperty('Idempotency-Key');
      expect(init?.headers).not.toHaveProperty('Content-Type');
    });

    it('reads a non-JSON body as null and a missing request id as null', async () => {
      const response = await sendStripeRequest(
        fetchAnswering(new Response(HTML_BODY, { status: 502 })),
        SECRET,
        { method: 'GET', path: '/v1/refunds/re_1' },
      );

      expect(response).toEqual({ status: 502, body: null, requestId: null });
    });

    it.each([
      ['a network error', new TypeError('fetch failed')],
      ['an abort', new DOMException('aborted', 'AbortError')],
    ])('turns %s into unavailable without the key', async (_case, error) => {
      const fetchFn = jest.fn<Promise<Response>, Parameters<typeof fetch>>(() =>
        Promise.reject(error),
      );

      const rejection = await rejectionOf(
        sendStripeRequest(fetchFn, SECRET, {
          method: 'GET',
          path: '/v1/refunds/re_1',
        }),
      );

      expect(rejection.kind).toBe('unavailable');
      expect(rejection.providerCode).toBe('stripe');
      expect(inspect(rejection, { depth: null })).not.toContain(SECRET_KEY);
    });

    it('gives up as unavailable when Stripe does not answer within the timeout', async () => {
      jest.useFakeTimers();
      jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException('timed out', 'TimeoutError')),
          ms,
        );

        return controller.signal;
      });
      const fetchFn = jest.fn<Promise<Response>, Parameters<typeof fetch>>(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason as Error),
            );
          }),
      );
      let isSettled = false;

      const work = rejectionOf(
        sendStripeRequest(fetchFn, SECRET, {
          method: 'GET',
          path: '/v1/refunds/re_1',
        }),
      ).finally(() => {
        isSettled = true;
      });
      await jest.advanceTimersByTimeAsync(STRIPE_REQUEST_TIMEOUT_MS - 1);
      expect(isSettled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      const rejection = await work;
      expect(rejection.kind).toBe('unavailable');
      expect(rejection.message).toBe(
        'stripe GET /v1/refunds/re_1 failed: TimeoutError',
      );
    });
  });

  describe('stripeErrorOf', () => {
    it.each([
      [401, errorBodyFixture('invalid_request_error', null), 'misconfigured'],
      [
        403,
        errorBodyFixture('invalid_request_error', 'secret_key_required'),
        'misconfigured',
      ],
      [400, errorBodyFixture('idempotency_error', null), 'misconfigured'],
      [
        400,
        errorBodyFixture('invalid_request_error', 'livemode_mismatch'),
        'misconfigured',
      ],
      [
        400,
        errorBodyFixture('invalid_request_error', 'parameter_unknown'),
        'misconfigured',
      ],
      [
        400,
        errorBodyFixture('invalid_request_error', 'parameter_missing'),
        'misconfigured',
      ],
      [
        400,
        errorBodyFixture('invalid_request_error', 'parameter_invalid_empty'),
        'misconfigured',
      ],
      [
        400,
        {
          error: {
            type: 'invalid_request_error',
            code: null,
            message:
              'Refund amount ($7.35) is greater than charge amount ($7.34)',
          },
        },
        'rejected',
      ],
      [
        400,
        {
          error: {
            type: 'invalid_request_error',
            code: null,
            message:
              'Refund amount ($3.00) is greater than unrefunded amount on charge ($2.34)',
          },
        },
        'rejected',
      ],
      [
        400,
        {
          error: {
            type: 'invalid_request_error',
            code: null,
            message: 'Invalid Stripe API version: 2099-01-01.bogus',
          },
        },
        'rejected',
      ],
      [402, errorBodyFixture('card_error', 'card_declined'), 'rejected'],
      [
        400,
        errorBodyFixture('invalid_request_error', 'amount_too_small'),
        'rejected',
      ],
      [
        400,
        errorBodyFixture('invalid_request_error', 'charge_already_refunded'),
        'rejected',
      ],
      [
        404,
        errorBodyFixture('invalid_request_error', 'resource_missing'),
        'rejected',
      ],
      [409, errorBodyFixture('idempotency_error', null), 'unavailable'],
      [424, errorBodyFixture('api_error', null), 'unavailable'],
      [
        429,
        errorBodyFixture('invalid_request_error', 'rate_limit'),
        'unavailable',
      ],
      [500, errorBodyFixture('api_error', null), 'unavailable'],
      [502, null, 'unavailable'],
      [400, null, 'unavailable'],
      [404, { message: 'not stripe' }, 'unavailable'],
      [302, errorBodyFixture('invalid_request_error', null), 'unavailable'],
    ])('maps %i with %j to %s', (status, body, kind) => {
      expect(errorOf(status, body).kind).toBe(kind);
    });

    it('names the status, type, code, message and request id', () => {
      const body = errorBodyFixture(
        'card_error',
        'card_declined',
        'Your card was declined.',
      );

      const error = errorOf(402, body);

      expect(error.message).toBe(
        `stripe 402 card_error/card_declined: Your card was declined. (request ${REQUEST_ID})`,
      );
      expect(error.providerCode).toBe('stripe');
      expect(error.cause).toEqual(body);
    });

    it('names the request id of an answer without an error body', () => {
      expect(errorOf(502, null).message).toBe(
        `stripe 502 without an error body (request ${REQUEST_ID})`,
      );
    });

    it.each([
      [401, 'Invalid API Key provided'],
      [403, 'The provided key does not have the required permissions'],
    ])('keeps neither the key nor Stripe text of a %i', (status, prefix) => {
      const stripeText = `${prefix}: ${SECRET_KEY.slice(0, 12)}****${SECRET_KEY.slice(-4)}`;

      const error = errorOf(
        status,
        errorBodyFixture('invalid_request_error', null, stripeText),
      );

      expect(error.kind).toBe('misconfigured');
      expect(error.message).toBe(
        `stripe ${status} invalid_request_error/none (request ${REQUEST_ID})`,
      );
      expect(error.cause).toEqual({
        type: 'invalid_request_error',
        code: null,
      });
      for (const text of [
        error.message,
        JSON.stringify(error.cause),
        inspect(error, { depth: null }),
      ]) {
        expect(text).not.toContain(prefix);
        expect(text).not.toContain(SECRET_KEY.slice(-4));
      }
    });
  });
});
