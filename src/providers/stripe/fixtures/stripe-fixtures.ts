import { randomInt } from 'node:crypto';

import type { WebhookRequest } from '../../payment-provider.port';
import { signatureHeaderOf } from '../stripe-signature';

type StripePaymentIntentFixture = {
  id: string;
  object: 'payment_intent';
  status: string;
};

type StripeSessionFixture = {
  id: string;
  object: 'checkout.session';
  mode: string;
  livemode: boolean;
  status: string | null;
  payment_status: string;
  amount_subtotal: number | null;
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  payment_intent: string | StripePaymentIntentFixture | null;
  metadata: Record<string, string>;
  url: string | null;
  created: number;
  expires_at: number;
};

type StripeRefundFixture = {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  status: string | null;
  payment_intent: string | null;
  metadata: Record<string, string>;
  created: number;
};

type StripeListFixture<Item> = {
  object: 'list';
  url: string;
  has_more: boolean;
  data: Item[];
};

type StripeEventFixture<Data> = {
  id: string;
  object: 'event';
  api_version: string;
  created: number;
  livemode: boolean;
  type: string;
  data: { object: Data };
};

type StripeErrorBodyFixture = {
  error: {
    type: string;
    code?: string;
    message: string;
    doc_url?: string;
  };
};

const STRIPE_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const STRIPE_ID_LENGTH = 24;
const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
const FIXTURE_CREATED_SECONDS = 1_762_855_200;
const SESSION_LIFETIME_SECONDS = 24 * 60 * 60;
const FIXTURE_API_VERSION = '2026-10-28.endive';

const syntheticStripeId = (prefix: string): string =>
  `${prefix}_${Array.from(
    { length: STRIPE_ID_LENGTH },
    () => STRIPE_ID_ALPHABET[randomInt(STRIPE_ID_ALPHABET.length)],
  ).join('')}`;

const checkoutUrlOf = (sessionId: string): string =>
  `https://checkout.stripe.com/c/pay/${sessionId}#fidkdWxOYHwnPyd1blpxYHZxWjA0`;

const paymentIntentFixture = (
  overrides: Partial<StripePaymentIntentFixture> = {},
): StripePaymentIntentFixture => ({
  id: syntheticStripeId('pi'),
  object: 'payment_intent',
  status: 'succeeded',
  ...overrides,
});

const sessionFixture = (
  overrides: Partial<StripeSessionFixture> = {},
): StripeSessionFixture => {
  const id = overrides.id ?? syntheticStripeId('cs_test');

  return {
    id,
    object: 'checkout.session',
    mode: 'payment',
    livemode: false,
    status: 'open',
    payment_status: 'unpaid',
    amount_subtotal: 734,
    amount_total: 734,
    currency: 'usd',
    client_reference_id: '5b0b3a0e-6f0c-4c43-9d5e-0a8a7d5e1c11',
    payment_intent: null,
    metadata: {},
    url: checkoutUrlOf(id),
    created: FIXTURE_CREATED_SECONDS,
    expires_at: FIXTURE_CREATED_SECONDS + SESSION_LIFETIME_SECONDS,
    ...overrides,
  };
};

const paidSessionFixture = (
  overrides: Partial<StripeSessionFixture> = {},
): StripeSessionFixture =>
  sessionFixture({
    status: 'complete',
    payment_status: 'paid',
    payment_intent: syntheticStripeId('pi'),
    url: null,
    ...overrides,
  });

const refundFixture = (
  overrides: Partial<StripeRefundFixture> = {},
): StripeRefundFixture => ({
  id: syntheticStripeId('re'),
  object: 'refund',
  amount: 200,
  currency: 'usd',
  status: 'succeeded',
  payment_intent: syntheticStripeId('pi'),
  metadata: {},
  created: FIXTURE_CREATED_SECONDS,
  ...overrides,
});

const refundListFixture = (
  refunds: StripeRefundFixture[],
  hasMore = false,
): StripeListFixture<StripeRefundFixture> => ({
  object: 'list',
  url: '/v1/refunds',
  has_more: hasMore,
  data: refunds,
});

const eventFixture = <Data>(
  type: string,
  object: Data,
  overrides: Partial<StripeEventFixture<Data>> = {},
): StripeEventFixture<Data> => ({
  id: syntheticStripeId('evt'),
  object: 'event',
  api_version: FIXTURE_API_VERSION,
  created: FIXTURE_CREATED_SECONDS,
  livemode: false,
  type,
  data: { object },
  ...overrides,
});

const errorBodyFixture = (
  type: string,
  code: string | null,
  message = `Synthetic ${type}`,
): StripeErrorBodyFixture => ({
  error: {
    type,
    ...(code === null ? {} : { code }),
    message,
    doc_url: 'https://stripe.com/docs/error-codes',
  },
});

const signedStripeWebhook = (
  body: unknown,
  secret: string,
  nowEpochMs: number,
): WebhookRequest => {
  const rawBody = Buffer.from(JSON.stringify(body));

  return {
    rawBody,
    headers: {
      [STRIPE_SIGNATURE_HEADER]: signatureHeaderOf(rawBody, secret, nowEpochMs),
    },
  };
};

export {
  checkoutUrlOf,
  errorBodyFixture,
  eventFixture,
  paidSessionFixture,
  paymentIntentFixture,
  refundFixture,
  refundListFixture,
  sessionFixture,
  signedStripeWebhook,
  STRIPE_SIGNATURE_HEADER,
  syntheticStripeId,
};
export type {
  StripeErrorBodyFixture,
  StripeEventFixture,
  StripeListFixture,
  StripePaymentIntentFixture,
  StripeRefundFixture,
  StripeSessionFixture,
};
