import {
  ProviderError,
  type ProviderErrorKind,
} from '../payment-provider.port';

import { paddleErrorBodySchema, parseJsonOrNull } from './paddle-wire-format';

type PaddleRequest = {
  method: 'GET' | 'POST';
  path: string;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
};

type PaddleResponse = { status: number; body: unknown };

const PADDLE_API_BASE_URL = 'https://sandbox-api.paddle.com';
const PADDLE_API_VERSION = '1';
const PADDLE_REQUEST_TIMEOUT_MS = 8000;
const PADDLE_MAX_REQUESTS_PER_CALL = 3;
const DEFAULT_CHECKOUT_URL_NOT_SET_CODE =
  'transaction_default_checkout_url_not_set';

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;

const paddleError = (
  message: string,
  kind: ProviderErrorKind,
  cause?: unknown,
): ProviderError =>
  new ProviderError(message, { providerCode: 'paddle', kind, cause });

const isOk = ({ status }: PaddleResponse): boolean =>
  status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;

const urlOf = ({ path, query }: PaddleRequest): string => {
  const url = new URL(path, PADDLE_API_BASE_URL);
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, value);
  }

  return url.toString();
};

const sendPaddleRequest = async (
  fetchFn: typeof fetch,
  apiKey: string,
  request: PaddleRequest,
): Promise<PaddleResponse> => {
  try {
    const response = await fetchFn(urlOf(request), {
      method: request.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Paddle-Version': PADDLE_API_VERSION,
        ...(request.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      // Also bounds the body read below.
      signal: AbortSignal.timeout(PADDLE_REQUEST_TIMEOUT_MS),
    });

    return {
      status: response.status,
      body: parseJsonOrNull(await response.text()),
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'unknown';

    throw paddleError(
      `paddle ${request.method} ${request.path} failed: ${errorName}`,
      'unavailable',
      error,
    );
  }
};

const failureKindOf = (
  status: number,
  errorCode: string | null,
): ProviderErrorKind => {
  if (errorCode === DEFAULT_CHECKOUT_URL_NOT_SET_CODE) return 'misconfigured';
  if (status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN) {
    return 'unavailable';
  }
  // Without Paddle's error body the answer came from a proxy, not from Paddle.
  if (
    errorCode === null ||
    status < HTTP_CLIENT_ERROR_MIN ||
    status > HTTP_CLIENT_ERROR_MAX
  ) {
    return 'unavailable';
  }
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return 'misconfigured';
  }

  return 'rejected';
};

const paddleErrorOf = (response: PaddleResponse): ProviderError => {
  const errorBody = paddleErrorBodySchema.safeParse(response.body);
  if (!errorBody.success) {
    return paddleError(
      `paddle ${response.status} without an error body`,
      failureKindOf(response.status, null),
      response.body,
    );
  }

  const { error, meta } = errorBody.data;

  return paddleError(
    `paddle ${response.status} ${error.code}: ${error.detail} (request ${meta.request_id})`,
    failureKindOf(response.status, error.code),
    response.body,
  );
};

export {
  isOk,
  PADDLE_API_BASE_URL,
  PADDLE_MAX_REQUESTS_PER_CALL,
  PADDLE_REQUEST_TIMEOUT_MS,
  paddleError,
  paddleErrorOf,
  sendPaddleRequest,
};
export type { PaddleRequest, PaddleResponse };
