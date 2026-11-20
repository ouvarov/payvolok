import { z } from 'zod';

import { CURRENCY_PATTERN } from '@/common/currency';

import type {
  ProviderPaymentStatus,
  ProviderRefundStatus,
} from '../payment-provider.port';
import type { ProviderEvent, ProviderPaymentEvent } from '../provider-events';

type EventContext = { dedupKey: string; occurredAt: string | null };

const CHECKOUT_SESSION_ID_PATTERN = /^cs_test_[A-Za-z0-9]+$/;
const REFUND_ID_PATTERN = /^re_[A-Za-z0-9]+$/;
const PAYMENT_INTENT_ID_PATTERN = /^pi_[A-Za-z0-9]+$/;
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9]+$/;

// Two-decimal currencies only: their Stripe minor unit equals the ISO one.
const STRIPE_CURRENCIES: readonly string[] = ['USD', 'EUR', 'UAH'];

const STRIPE_ASYNC_PAYMENT_FAILED_REASON = 'stripe_async_payment_failed';
const MS_PER_SECOND = 1000;

const REFUND_STATUSES: ReadonlyMap<string, ProviderRefundStatus> = new Map<
  string,
  ProviderRefundStatus
>([
  ['pending', 'pending'],
  ['requires_action', 'pending'],
  ['succeeded', 'succeeded'],
  ['failed', 'failed'],
  ['canceled', 'failed'],
]);

const FAILED_PAYMENT_INTENT_STATUSES: ReadonlySet<string> = new Set([
  'requires_payment_method',
  'canceled',
]);

const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

const amountMinorSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const paymentIntentIdSchema = z.string().regex(PAYMENT_INTENT_ID_PATTERN);

const stripeCreatedSessionSchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
});

const stripeSessionSchema = z.object({
  id: z.string(),
  mode: z.string(),
  livemode: z.boolean(),
  status: z.string().nullable(),
  payment_status: z.string(),
  amount_total: amountMinorSchema.nullable(),
  currency: z.string().nullable(),
  client_reference_id: z.string().nullable(),
  payment_intent: z
    .union([
      paymentIntentIdSchema,
      z.object({ id: paymentIntentIdSchema, status: z.string() }),
    ])
    .nullable(),
});

const stripeRefundSchema = z.object({
  id: z.string().regex(REFUND_ID_PATTERN),
  amount: amountMinorSchema,
  currency: z.string(),
  status: z.string().nullable(),
  payment_intent: z.string().nullable(),
});

const stripeRefundListSchema = z.object({
  has_more: z.boolean(),
  data: z.array(stripeRefundSchema),
});

const stripeEventSchema = z.object({
  id: z.string().regex(EVENT_ID_PATTERN),
  type: z.string(),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

const stripeErrorBodySchema = z.object({
  error: z.object({
    type: z.string(),
    code: z.string().nullish(),
    message: z.string().nullish(),
  }),
});

type StripeSession = z.infer<typeof stripeSessionSchema>;
type StripeRefund = z.infer<typeof stripeRefundSchema>;
type StripeEvent = z.infer<typeof stripeEventSchema>;
type StripeErrorBody = z.infer<typeof stripeErrorBodySchema>;

const currencyOf = (stripeCurrency: string | null): string | null => {
  const currency = stripeCurrency?.toUpperCase() ?? null;

  return currency !== null && CURRENCY_PATTERN.test(currency) ? currency : null;
};

const toStripeCurrency = (currency: string): string => currency.toLowerCase();

const isStripeCurrency = (currency: string): boolean =>
  STRIPE_CURRENCIES.includes(currency);

const paymentIntentIdOf = (session: StripeSession): string | null => {
  const { payment_intent: paymentIntent } = session;
  if (paymentIntent === null) return null;

  return typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id;
};

const paymentIntentStatusOf = (session: StripeSession): string | null =>
  typeof session.payment_intent === 'object' && session.payment_intent !== null
    ? session.payment_intent.status
    : null;

const sessionStatusOf = (
  session: StripeSession,
): ProviderPaymentStatus | null => {
  if (session.status === 'open') return 'pending';
  if (session.status === 'expired') return 'expired';
  if (session.status !== 'complete') return null;
  if (session.payment_status === 'paid') return 'succeeded';
  if (session.payment_status !== 'unpaid') return null;

  const paymentIntentStatus = paymentIntentStatusOf(session);

  return paymentIntentStatus !== null &&
    FAILED_PAYMENT_INTENT_STATUSES.has(paymentIntentStatus)
    ? 'failed'
    : 'pending';
};

const refundStatusOf = (refund: StripeRefund): ProviderRefundStatus | null =>
  refund.status === null ? null : (REFUND_STATUSES.get(refund.status) ?? null);

const occurredAtOf = (createdSeconds: number): string | null => {
  const occurredAt = new Date(createdSeconds * MS_PER_SECOND);

  return Number.isNaN(occurredAt.getTime()) ? null : occurredAt.toISOString();
};

const sessionEventTypeOf = (
  eventType: string,
  session: StripeSession,
): ProviderPaymentEvent['type'] | null => {
  switch (eventType) {
    case 'checkout.session.completed':
      if (session.payment_status === 'paid') return 'payment.succeeded';
      return session.payment_status === 'unpaid' ? 'payment.pending' : null;
    case 'checkout.session.async_payment_succeeded':
      return 'payment.succeeded';
    case 'checkout.session.async_payment_failed':
      return 'payment.failed';
    case 'checkout.session.expired':
      return 'payment.expired';
    default:
      return null;
  }
};

const isTestPaymentSession = (
  event: StripeEvent,
  session: StripeSession,
): boolean =>
  !event.livemode &&
  !session.livemode &&
  session.mode === 'payment' &&
  CHECKOUT_SESSION_ID_PATTERN.test(session.id);

const unknownEventOf = (
  rawType: string,
  context: EventContext,
): ProviderEvent => ({ ...context, type: 'unknown', rawType });

const sessionEventOf = (
  event: StripeEvent,
  context: EventContext,
): ProviderEvent => {
  const parsed = stripeSessionSchema.safeParse(event.data.object);
  if (!parsed.success || !isTestPaymentSession(event, parsed.data)) {
    return unknownEventOf(event.type, context);
  }

  const session = parsed.data;
  const type = sessionEventTypeOf(event.type, session);
  const currency = currencyOf(session.currency);
  if (!type || session.amount_total === null || currency === null) {
    return unknownEventOf(event.type, context);
  }

  return {
    ...context,
    type,
    purpose: 'one_off',
    reference: session.client_reference_id,
    providerPaymentId: session.id,
    providerSubscriptionId: null,
    amountMinor: session.amount_total,
    currency,
    failureReason:
      type === 'payment.failed' ? STRIPE_ASYNC_PAYMENT_FAILED_REASON : null,
  };
};

// Refund events carry pi_ or ch_, never the cs_ id our payments hold; listRefunds records refunds instead.
const toProviderEvent = (event: StripeEvent): ProviderEvent => {
  const context: EventContext = {
    dedupKey: event.id,
    occurredAt: occurredAtOf(event.created),
  };

  return SESSION_EVENT_TYPES.has(event.type)
    ? sessionEventOf(event, context)
    : unknownEventOf(event.type, context);
};

const parseJsonOrNull = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export {
  CHECKOUT_SESSION_ID_PATTERN,
  currencyOf,
  isStripeCurrency,
  parseJsonOrNull,
  PAYMENT_INTENT_ID_PATTERN,
  paymentIntentIdOf,
  REFUND_ID_PATTERN,
  refundStatusOf,
  sessionStatusOf,
  STRIPE_ASYNC_PAYMENT_FAILED_REASON,
  STRIPE_CURRENCIES,
  stripeCreatedSessionSchema,
  stripeErrorBodySchema,
  stripeEventSchema,
  stripeRefundListSchema,
  stripeRefundSchema,
  stripeSessionSchema,
  toProviderEvent,
  toStripeCurrency,
};
export type { StripeErrorBody, StripeEvent, StripeRefund, StripeSession };
