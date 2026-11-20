import {
  ProviderError,
  type ProviderErrorKind,
} from '../payment-provider.port';
import type { RedactedSecret } from '../provider-credentials';

import {
  parseJsonOrNull,
  stripeErrorBodySchema,
  type StripeErrorBody,
} from './stripe-wire-format';

type FormValue = string | number | boolean | FormFields | FormValue[];
type FormFields = { [name: string]: FormValue };

type StripeRequest = {
  method: 'GET' | 'POST';
  path: string;
  query?: Readonly<Record<string, string>>;
  form?: FormFields;
  idempotencyKey?: string;
};

type StripeResponse = {
  status: number;
  body: unknown;
  requestId: string | null;
};

const STRIPE_API_BASE_URL = 'https://api.stripe.com';
const STRIPE_API_VERSION = '2026-10-28.endive';
const STRIPE_REQUEST_TIMEOUT_MS = 8000;
const STRIPE_MAX_REQUESTS_PER_CALL = 2;
const REQUEST_ID_HEADER = 'request-id';
const IDEMPOTENCY_ERROR_TYPE = 'idempotency_error';
const MISCONFIGURED_ERROR_CODES: ReadonlySet<string> = new Set([
  'livemode_mismatch',
  'testmode_charges_only',
  'account_invalid',
  'secret_key_required',
]);

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
// 409: the idempotency key is in use by a request still running; 424: Stripe's own dependency failed.
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([409, 424, 429]);

const stripeError = (
  message: string,
  kind: ProviderErrorKind,
  cause?: unknown,
): ProviderError =>
  new ProviderError(message, { providerCode: 'stripe', kind, cause });

const isOk = ({ status }: StripeResponse): boolean =>
  status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;

const formEntriesOf = (name: string, value: FormValue): [string, string][] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      formEntriesOf(`${name}[${index}]`, item),
    );
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      formEntriesOf(`${name}[${key}]`, item),
    );
  }

  return [[name, String(value)]];
};

const formBodyOf = (fields: FormFields): string =>
  new URLSearchParams(
    Object.entries(fields).flatMap(([name, value]) =>
      formEntriesOf(name, value),
    ),
  ).toString();

const urlOf = ({ path, query }: StripeRequest): string => {
  const url = new URL(path, STRIPE_API_BASE_URL);
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.append(name, value);
  }

  return url.toString();
};

const headersOf = (
  secretKey: RedactedSecret,
  { form, idempotencyKey }: StripeRequest,
): Record<string, string> => ({
  Authorization: `Bearer ${secretKey.reveal()}`,
  'Stripe-Version': STRIPE_API_VERSION,
  ...(form === undefined
    ? {}
    : { 'Content-Type': 'application/x-www-form-urlencoded' }),
  ...(idempotencyKey === undefined
    ? {}
    : { 'Idempotency-Key': idempotencyKey }),
});

// A timeout rejects with a DOMException, which is not an Error in every realm.
const errorNameOf = (error: unknown): string =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  typeof error.name === 'string'
    ? error.name
    : 'unknown';

const sendStripeRequest = async (
  fetchFn: typeof fetch,
  secretKey: RedactedSecret,
  request: StripeRequest,
): Promise<StripeResponse> => {
  try {
    const response = await fetchFn(urlOf(request), {
      method: request.method,
      headers: headersOf(secretKey, request),
      body: request.form === undefined ? undefined : formBodyOf(request.form),
      // Also bounds the body read below.
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
    });

    return {
      status: response.status,
      body: parseJsonOrNull(await response.text()),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    };
  } catch (error) {
    throw stripeError(
      `stripe ${request.method} ${request.path} failed: ${errorNameOf(error)}`,
      'unavailable',
      error,
    );
  }
};

const failureKindOf = (
  status: number,
  error: StripeErrorBody['error'] | null,
): ProviderErrorKind => {
  if (
    RETRYABLE_CLIENT_STATUSES.has(status) ||
    status >= HTTP_SERVER_ERROR_MIN
  ) {
    return 'unavailable';
  }
  // Without Stripe's error body the answer came from a proxy, not from Stripe.
  if (
    error === null ||
    status < HTTP_CLIENT_ERROR_MIN ||
    status > HTTP_CLIENT_ERROR_MAX
  ) {
    return 'unavailable';
  }
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return 'misconfigured';
  }
  if (
    error.type === IDEMPOTENCY_ERROR_TYPE ||
    MISCONFIGURED_ERROR_CODES.has(error.code ?? '')
  ) {
    return 'misconfigured';
  }

  return 'rejected';
};

const stripeErrorOf = (response: StripeResponse): ProviderError => {
  const requestLabel = `(request ${response.requestId ?? 'none'})`;
  const errorBody = stripeErrorBodySchema.safeParse(response.body);
  if (!errorBody.success) {
    return stripeError(
      `stripe ${response.status} without an error body ${requestLabel}`,
      failureKindOf(response.status, null),
      response.body,
    );
  }

  const { error } = errorBody.data;
  const kind = failureKindOf(response.status, error);
  const errorLabel = `${error.type}/${error.code ?? 'none'}`;
  // Stripe's 401 and 403 texts quote part of the key that was sent.
  if (
    response.status === HTTP_UNAUTHORIZED ||
    response.status === HTTP_FORBIDDEN
  ) {
    return stripeError(
      `stripe ${response.status} ${errorLabel} ${requestLabel}`,
      kind,
      { type: error.type, code: error.code ?? null },
    );
  }

  return stripeError(
    `stripe ${response.status} ${errorLabel}: ${error.message ?? ''} ${requestLabel}`,
    kind,
    response.body,
  );
};

export {
  formBodyOf,
  isOk,
  sendStripeRequest,
  STRIPE_API_BASE_URL,
  STRIPE_API_VERSION,
  STRIPE_MAX_REQUESTS_PER_CALL,
  STRIPE_REQUEST_TIMEOUT_MS,
  stripeError,
  stripeErrorOf,
};
export type { FormFields, StripeRequest, StripeResponse };
