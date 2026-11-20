import { z } from 'zod';

import { CURRENCY_PATTERN } from '@/common/currency';

import type {
  CreatedPayment,
  CreatedRefund,
  CreatePaymentInput,
  PaymentProvider,
  ProviderCapabilities,
  ProviderError,
  ProviderRefundRecord,
  ProviderRefundStatus,
  RefundInput,
  ResourceStatus,
  StatusQuery,
  WebhookRequest,
} from '../payment-provider.port';
import type { StripeCredentials } from '../provider-credentials';
import { dedupKeyFromBody, type ProviderEvents } from '../provider-events';

import {
  isOk,
  sendStripeRequest,
  stripeError,
  stripeErrorOf,
  type FormFields,
  type StripeRequest,
  type StripeResponse,
} from './stripe-http';
import { isSignatureValid } from './stripe-signature';
import {
  CHECKOUT_SESSION_ID_PATTERN,
  currencyOf,
  isStripeCurrency,
  parseJsonOrNull,
  paymentIntentIdOf,
  REFUND_ID_PATTERN,
  refundStatusOf,
  sessionStatusOf,
  stripeCreatedSessionSchema,
  stripeErrorBodySchema,
  stripeEventSchema,
  stripeRefundListSchema,
  stripeRefundSchema,
  stripeSessionSchema,
  toProviderEvent,
  toStripeCurrency,
  type StripeRefund,
  type StripeSession,
} from './stripe-wire-format';

const SIGNATURE_HEADER = 'stripe-signature';
const SESSIONS_PATH = '/v1/checkout/sessions';
const REFUNDS_PATH = '/v1/refunds';
const REFUNDS_PAGE_SIZE = 100;
const HTTP_NOT_FOUND = 404;
const RESOURCE_MISSING_CODE = 'resource_missing';
const PAYMENT_IDEMPOTENCY_PREFIX = 'payvolok-payment-';
const REFUND_IDEMPOTENCY_PREFIX = 'payvolok-refund-';

const STRIPE_CAPABILITIES: ProviderCapabilities = {
  recurring: 'managed',
  intervals: [],
  partialRefund: true,
  catalog: false,
  refundIdentity: 'provider',
};

const rejectedError = (message: string): ProviderError =>
  stripeError(message, 'rejected');

const unavailableError = (message: string): ProviderError =>
  stripeError(message, 'unavailable');

const isPositiveAmount = (amountMinor: number): boolean =>
  Number.isSafeInteger(amountMinor) && amountMinor > 0;

const isSupportedCurrency = (currency: string): boolean =>
  CURRENCY_PATTERN.test(currency) && isStripeCurrency(currency);

const isHttpsUrl = (text: string): boolean =>
  URL.canParse(text) && new URL(text).protocol === 'https:';

// Not sent: expires_at (Stripe's default is 24 h) and payment_method_types (refused on dynamic payment methods).
const sessionFormOf = (input: CreatePaymentInput): FormFields => ({
  mode: 'payment',
  line_items: [
    {
      quantity: 1,
      price_data: {
        currency: toStripeCurrency(input.currency),
        unit_amount: input.amountMinor,
        product_data: { name: input.description },
      },
    },
  ],
  client_reference_id: input.reference,
  metadata: { payvolok_reference: input.reference },
  payment_intent_data: { metadata: { payvolok_reference: input.reference } },
  success_url: input.returnUrl,
  cancel_url: input.returnUrl,
  adaptive_pricing: { enabled: false },
});

const bodyOf = <Output>(
  schema: z.ZodType<Output>,
  response: StripeResponse,
): Output => {
  if (!isOk(response)) throw stripeErrorOf(response);

  const body = schema.safeParse(response.body);
  if (!body.success) {
    throw unavailableError(
      `stripe ${response.status} answer does not match the expected shape (request ${response.requestId ?? 'none'})`,
    );
  }

  return body.data;
};

const isResourceMissing = (response: StripeResponse): boolean =>
  response.status === HTTP_NOT_FOUND &&
  stripeErrorBodySchema.safeParse(response.body).data?.error.code ===
    RESOURCE_MISSING_CODE;

const mappedRefundStatusOf = (refund: StripeRefund): ProviderRefundStatus => {
  const status = refundStatusOf(refund);
  if (!status) {
    throw unavailableError(
      `stripe refund ${refund.id} has status ${refund.status ?? 'null'}`,
    );
  }

  return status;
};

const refundCurrencyOf = (refund: StripeRefund): string => {
  const currency = currencyOf(refund.currency);
  if (currency === null) {
    throw unavailableError(`stripe refund ${refund.id} has no valid currency`);
  }

  return currency;
};

const refundRecordOf = (refund: StripeRefund): ProviderRefundRecord => ({
  providerRefundId: refund.id,
  status: mappedRefundStatusOf(refund),
  amountMinor: refund.amount,
  currency: refundCurrencyOf(refund),
});

const paymentStatusOf = (session: StripeSession): ResourceStatus => {
  const status = sessionStatusOf(session);
  const currency = currencyOf(session.currency);
  if (!status || session.amount_total === null || currency === null) {
    throw unavailableError(
      `stripe session ${session.id} is ${session.status ?? 'null'}/${session.payment_status}`,
    );
  }

  return {
    resource: 'payment',
    providerPaymentId: session.id,
    status,
    amountMinor: session.amount_total,
    currency,
  };
};

const unknownBodyEvents = (rawBody: Buffer): ProviderEvents => [
  {
    type: 'unknown',
    rawType: null,
    dedupKey: dedupKeyFromBody(rawBody),
    occurredAt: null,
  },
];

export class StripeProvider implements PaymentProvider<StripeCredentials> {
  readonly code = 'stripe';
  readonly capabilities = STRIPE_CAPABILITIES;
  readonly webhookHeaders = [SIGNATURE_HEADER];

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly nowEpochMs: () => number = Date.now,
  ) {}

  async createPayment(
    credentials: StripeCredentials,
    input: CreatePaymentInput,
  ): Promise<CreatedPayment> {
    if (
      !isPositiveAmount(input.amountMinor) ||
      !isSupportedCurrency(input.currency)
    ) {
      throw rejectedError('Payment amount or currency is not supported');
    }

    const session = bodyOf(
      stripeCreatedSessionSchema,
      await this.send(credentials, {
        method: 'POST',
        path: SESSIONS_PATH,
        form: sessionFormOf(input),
        idempotencyKey: `${PAYMENT_IDEMPOTENCY_PREFIX}${input.reference}`,
      }),
    );
    if (!CHECKOUT_SESSION_ID_PATTERN.test(session.id)) {
      throw unavailableError(
        'stripe answered a session id that is not a test session',
      );
    }
    if (session.url === null || !isHttpsUrl(session.url)) {
      throw unavailableError(
        `stripe session ${session.id} has no https checkout url`,
      );
    }

    return {
      providerPaymentId: session.id,
      redirectUrl: session.url,
      status: 'pending',
    };
  }

  async refund(
    credentials: StripeCredentials,
    input: RefundInput,
  ): Promise<CreatedRefund> {
    if (
      !isPositiveAmount(input.amountMinor) ||
      !isSupportedCurrency(input.currency) ||
      !CHECKOUT_SESSION_ID_PATTERN.test(input.providerPaymentId)
    ) {
      throw rejectedError('Refund amount, currency or payment id is invalid');
    }

    const session = await this.sessionOf(credentials, input.providerPaymentId);
    const paymentIntentId = paymentIntentIdOf(session);
    if (session.payment_status !== 'paid' || paymentIntentId === null) {
      throw rejectedError(`Session is ${session.payment_status}`);
    }
    if (currencyOf(session.currency) !== input.currency) {
      throw rejectedError('Refund currency differs');
    }

    // Stripe itself refuses an amount above what is left, so no pre-check of earlier refunds.
    const refund = bodyOf(
      stripeRefundSchema,
      await this.send(credentials, {
        method: 'POST',
        path: REFUNDS_PATH,
        form: {
          payment_intent: paymentIntentId,
          amount: input.amountMinor,
          metadata: { payvolok_refund_reference: input.reference },
        },
        idempotencyKey: `${REFUND_IDEMPOTENCY_PREFIX}${input.reference}`,
      }),
    );

    return {
      providerRefundId: refund.id,
      status: mappedRefundStatusOf(refund),
    };
  }

  getStatus(
    credentials: StripeCredentials,
    query: StatusQuery,
  ): Promise<ResourceStatus | null> {
    return query.resource === 'payment'
      ? this.paymentStatusOf(credentials, query.providerPaymentId)
      : this.refundStatusOf(credentials, query.providerRefundId);
  }

  async listRefunds(
    credentials: StripeCredentials,
    providerPaymentId: string,
  ): Promise<readonly ProviderRefundRecord[]> {
    if (!CHECKOUT_SESSION_ID_PATTERN.test(providerPaymentId)) {
      throw rejectedError('Payment id is not a checkout session');
    }

    const session = await this.sessionOf(credentials, providerPaymentId);
    const paymentIntentId = paymentIntentIdOf(session);
    if (paymentIntentId === null) return [];

    const page = bodyOf(
      stripeRefundListSchema,
      await this.send(credentials, {
        method: 'GET',
        path: REFUNDS_PATH,
        query: {
          payment_intent: paymentIntentId,
          limit: String(REFUNDS_PAGE_SIZE),
        },
      }),
    );
    if (page.has_more) {
      throw unavailableError(
        `stripe session ${providerPaymentId} has more refunds than one page`,
      );
    }

    return page.data
      .filter(({ payment_intent }) => payment_intent === paymentIntentId)
      .map(refundRecordOf);
  }

  // Any of the secrets: during a rotation Stripe signs with the old one too.
  verifyWebhook(
    credentials: StripeCredentials,
    request: WebhookRequest,
  ): Promise<boolean> {
    if (credentials.webhookSecrets.length === 0) {
      return Promise.reject(
        stripeError('stripe webhook secret is not configured', 'misconfigured'),
      );
    }

    const nowEpochMs = this.nowEpochMs();

    return Promise.resolve(
      credentials.webhookSecrets.some((secret) =>
        isSignatureValid(
          request.headers[SIGNATURE_HEADER],
          request.rawBody,
          secret.reveal(),
          nowEpochMs,
        ),
      ),
    );
  }

  parseWebhook(request: WebhookRequest): ProviderEvents {
    const event = stripeEventSchema.safeParse(
      parseJsonOrNull(request.rawBody.toString('utf8')),
    );
    if (!event.success) return unknownBodyEvents(request.rawBody);

    return [toProviderEvent(event.data)];
  }

  private async sessionOf(
    credentials: StripeCredentials,
    sessionId: string,
  ): Promise<StripeSession> {
    return bodyOf(
      stripeSessionSchema,
      await this.send(credentials, {
        method: 'GET',
        path: `${SESSIONS_PATH}/${sessionId}`,
      }),
    );
  }

  private async paymentStatusOf(
    credentials: StripeCredentials,
    providerPaymentId: string,
  ): Promise<ResourceStatus | null> {
    if (!CHECKOUT_SESSION_ID_PATTERN.test(providerPaymentId)) return null;

    const response = await this.send(credentials, {
      method: 'GET',
      path: `${SESSIONS_PATH}/${providerPaymentId}`,
      query: { 'expand[]': 'payment_intent' },
    });
    if (isResourceMissing(response)) return null;

    return paymentStatusOf(bodyOf(stripeSessionSchema, response));
  }

  private async refundStatusOf(
    credentials: StripeCredentials,
    providerRefundId: string | null,
  ): Promise<ResourceStatus | null> {
    if (
      providerRefundId === null ||
      !REFUND_ID_PATTERN.test(providerRefundId)
    ) {
      return null;
    }

    const response = await this.send(credentials, {
      method: 'GET',
      path: `${REFUNDS_PATH}/${providerRefundId}`,
    });
    if (isResourceMissing(response)) return null;

    const refund = bodyOf(stripeRefundSchema, response);

    return { resource: 'refund', ...refundRecordOf(refund) };
  }

  private send(
    { secretKey }: StripeCredentials,
    request: StripeRequest,
  ): Promise<StripeResponse> {
    if (secretKey === null) {
      return Promise.reject(
        stripeError('stripe secret key is not configured', 'misconfigured'),
      );
    }

    return sendStripeRequest(this.fetchFn, secretKey, request);
  }
}
