import { inspect } from 'node:util';

import { IDEMPOTENCY_LEASE_SECONDS } from '@/idempotency/idempotency.constants';

import { ProviderError } from '../payment-provider.port';
import { RedactedSecret } from '../provider-credentials';

import {
  errorBodyFixture,
  forbiddenHtmlFixture,
} from './fixtures/paddle-fixtures';
import {
  PADDLE_MAX_REQUESTS_PER_CALL,
  PADDLE_REQUEST_TIMEOUT_MS,
  paddleErrorOf,
  sendPaddleRequest,
} from './paddle-http';

const API_KEY = `pdl_sdbx_apikey_${'k'.repeat(53)}`;
const SANDBOX_ACCESS = {
  apiKey: new RedactedSecret(API_KEY),
  environment: 'sandbox' as const,
};

const fetchAnswering = (response: Response) =>
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

describe('paddle http', () => {
  describe('timeout budget', () => {
    it('keeps every request of one call under half the idempotency lease', () => {
      expect(
        PADDLE_REQUEST_TIMEOUT_MS * PADDLE_MAX_REQUESTS_PER_CALL,
      ).toBeLessThan((IDEMPOTENCY_LEASE_SECONDS * 1000) / 2);
    });
  });

  describe('sendPaddleRequest', () => {
    it('sends the key, the API version, JSON and an abort signal to the sandbox', async () => {
      const fetchFn = fetchAnswering(
        new Response('{"data":{}}', { status: 201 }),
      );

      const response = await sendPaddleRequest(fetchFn, SANDBOX_ACCESS, {
        method: 'POST',
        path: '/transactions',
        body: { currency_code: 'USD' },
      });

      expect(response).toEqual({ status: 201, body: { data: {} } });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('https://sandbox-api.paddle.com/transactions');
      expect(init).toMatchObject({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Paddle-Version': '1',
          'Content-Type': 'application/json',
        },
        body: '{"currency_code":"USD"}',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('sends a live account to the live API with its own key', async () => {
      const fetchFn = fetchAnswering(new Response('{"data":{}}'));
      const liveKey = `pdl_live_apikey_${'l'.repeat(53)}`;

      await sendPaddleRequest(
        fetchFn,
        { apiKey: new RedactedSecret(liveKey), environment: 'live' },
        { method: 'GET', path: '/transactions/txn_1' },
      );

      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('https://api.paddle.com/transactions/txn_1');
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${liveKey}`,
      });
    });

    it('encodes query parameters', async () => {
      const fetchFn = fetchAnswering(new Response('{"data":[]}'));

      await sendPaddleRequest(fetchFn, SANDBOX_ACCESS, {
        method: 'GET',
        path: '/adjustments',
        query: { id: 'adj_1', transaction_id: 'txn_1&x=y' },
      });

      expect(fetchFn.mock.calls[0][0]).toBe(
        'https://sandbox-api.paddle.com/adjustments?id=adj_1&transaction_id=txn_1%26x%3Dy',
      );
      expect(fetchFn.mock.calls[0][1]?.body).toBeUndefined();
    });

    it('reads a non-JSON body as null', async () => {
      const response = await sendPaddleRequest(
        fetchAnswering(new Response(forbiddenHtmlFixture(), { status: 403 })),
        SANDBOX_ACCESS,
        { method: 'GET', path: '/transactions/txn_1' },
      );

      expect(response).toEqual({ status: 403, body: null });
    });

    it.each([
      ['a network error', new TypeError('fetch failed')],
      ['a timeout', new DOMException('timed out', 'TimeoutError')],
      ['an abort', new DOMException('aborted', 'AbortError')],
    ])('turns %s into unavailable without the key', async (_case, error) => {
      const fetchFn = jest.fn<Promise<Response>, Parameters<typeof fetch>>(() =>
        Promise.reject(error),
      );

      const rejection = await rejectionOf(
        sendPaddleRequest(fetchFn, SANDBOX_ACCESS, {
          method: 'GET',
          path: '/transactions/txn_1',
        }),
      );

      expect(rejection.kind).toBe('unavailable');
      expect(rejection.providerCode).toBe('paddle');
      expect(inspect(rejection, { depth: null })).not.toContain(API_KEY);
      expect(JSON.stringify(rejection.cause)).not.toContain(API_KEY);
    });
  });

  describe('paddleErrorOf', () => {
    it.each([
      [403, 'an HTML body', null],
      [400, 'no body', null],
      [302, 'a redirect with an error body', errorBodyFixture('invalid_field')],
      [503, 'no body', null],
    ])('maps %i with %s to unavailable', (status, _case, body) => {
      expect(paddleErrorOf({ status, body }).kind).toBe('unavailable');
    });

    it('names the status, code, detail and request id', () => {
      const error = paddleErrorOf({
        status: 404,
        body: errorBodyFixture('not_found'),
      });

      expect(error.message).toBe(
        'paddle 404 not_found: Entity txn_01jcsyntheticpayment000001 not found (request e4f5a6b7-c8d9-4e0f-8a1b-3c4d5e6f7a09)',
      );
      expect(error.cause).toEqual(errorBodyFixture('not_found'));
    });
  });
});
