import { z } from 'zod';

import { CURRENCY_PATTERN } from '@/common/currency';

import type {
  ProviderPaymentStatus,
  ProviderRefundStatus,
} from '../payment-provider.port';
import type {
  ProviderEvent,
  ProviderPaymentEvent,
  ProviderRefundEvent,
} from '../provider-events';

type EventContext = { dedupKey: string; occurredAt: string | null };

const TRANSACTION_ID_PATTERN = /^txn_[a-z\d]{26}$/;
const TRANSACTION_ITEM_ID_PATTERN = /^txnitm_[a-z\d]{26}$/;
const ADJUSTMENT_ID_PATTERN = /^adj_[a-z\d]{26}$/;
const AMOUNT_PATTERN = /^\d+$/;

const PADDLE_PAYMENT_FAILED_REASON = 'paddle_payment_failed';
const PADDLE_CANCELED_REASON = 'paddle_canceled';

const TRANSACTION_STATUSES: ReadonlyMap<string, ProviderPaymentStatus> =
  new Map<string, ProviderPaymentStatus>([
    ['draft', 'pending'],
    ['ready', 'pending'],
    ['billed', 'pending'],
    ['paid', 'pending'],
    ['past_due', 'pending'],
    ['completed', 'succeeded'],
    ['canceled', 'failed'],
  ]);

const ADJUSTMENT_STATUSES: ReadonlyMap<string, ProviderRefundStatus> = new Map<
  string,
  ProviderRefundStatus
>([
  ['pending_approval', 'pending'],
  ['approved', 'succeeded'],
  ['rejected', 'failed'],
]);

const PAYMENT_EVENT_TYPES: ReadonlyMap<string, ProviderPaymentEvent['type']> =
  new Map<string, ProviderPaymentEvent['type']>([
    ['transaction.completed', 'payment.succeeded'],
    ['transaction.payment_failed', 'payment.attempt_failed'],
    ['transaction.canceled', 'payment.failed'],
  ]);

const REFUND_EVENT_TYPES: ReadonlyMap<
  ProviderRefundStatus,
  ProviderRefundEvent['type']
> = new Map<ProviderRefundStatus, ProviderRefundEvent['type']>([
  ['pending', 'refund.pending'],
  ['succeeded', 'refund.succeeded'],
  ['failed', 'refund.failed'],
]);

const ADJUSTMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'adjustment.created',
  'adjustment.updated',
]);

const amountMinorOf = (text: string): number | null => {
  if (!AMOUNT_PATTERN.test(text)) return null;

  const amount = Number(text);

  return Number.isSafeInteger(amount) ? amount : null;
};

const amountMinorSchema = z.string().transform((text, context) => {
  const amount = amountMinorOf(text);
  if (amount !== null) return amount;

  context.addIssue({ code: 'custom', message: 'Amount is not an integer' });
  return z.NEVER;
});

const currencySchema = z.string().regex(CURRENCY_PATTERN);
const transactionIdSchema = z.string().regex(TRANSACTION_ID_PATTERN);
const transactionTotalsSchema = z.object({
  total: amountMinorSchema,
  grand_total: amountMinorSchema,
});

const paddleTransactionSchema = z.object({
  id: transactionIdSchema,
  status: z.string(),
  currency_code: currencySchema,
  custom_data: z.record(z.string(), z.unknown()).nullable(),
  subscription_id: z.string().nullable(),
  details: z.object({ totals: transactionTotalsSchema }),
  payments: z
    .array(z.object({ error_code: z.string().nullable().optional() }))
    .optional(),
});

const paddleRefundableTransactionSchema = paddleTransactionSchema.extend({
  details: z.object({
    totals: transactionTotalsSchema,
    line_items: z.array(
      z.object({ id: z.string().regex(TRANSACTION_ITEM_ID_PATTERN) }),
    ),
  }),
});

const paddleCreatedTransactionSchema = z.object({
  id: transactionIdSchema,
  checkout: z.object({ url: z.string().nullable() }).nullable().optional(),
});

const paddleAdjustmentSchema = z.object({
  id: z.string().regex(ADJUSTMENT_ID_PATTERN),
  action: z.string(),
  status: z.string(),
  transaction_id: transactionIdSchema,
  subscription_id: z.string().nullable(),
  currency_code: currencySchema,
  totals: z.object({ total: amountMinorSchema }),
});

const paddleAdjustmentPageSchema = z.object({
  data: z.array(paddleAdjustmentSchema),
  meta: z.object({ pagination: z.object({ has_more: z.boolean() }) }),
});

const paddleEnvelopeSchema = z.object({
  event_id: z.string().startsWith('evt_'),
  event_type: z.string(),
  occurred_at: z.unknown(),
  data: z.unknown(),
});

const paddleErrorBodySchema = z.object({
  error: z.object({
    type: z.string(),
    code: z.string(),
    detail: z.string(),
    errors: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional(),
  }),
  meta: z.object({ request_id: z.string() }),
});

const occurredAtSchema = z.iso.datetime({ offset: true });

type PaddleEnvelope = z.infer<typeof paddleEnvelopeSchema>;
type PaddleTransaction = z.infer<typeof paddleTransactionSchema>;
type PaddleRefundableTransaction = z.infer<
  typeof paddleRefundableTransactionSchema
>;
type PaddleAdjustment = z.infer<typeof paddleAdjustmentSchema>;

const occurredAtOf = (value: unknown): string | null => {
  const occurredAt = occurredAtSchema.safeParse(value);

  return occurredAt.success ? occurredAt.data : null;
};

const referenceOf = (transaction: PaddleTransaction): string | null => {
  const reference = transaction.custom_data?.reference;

  return typeof reference === 'string' ? reference : null;
};

// Paddle lists payment attempts newest first.
const failureReasonOf = (
  type: ProviderPaymentEvent['type'],
  transaction: PaddleTransaction,
): string | null => {
  if (type === 'payment.failed') return PADDLE_CANCELED_REASON;
  if (type !== 'payment.attempt_failed') return null;

  const latestErrorCode = transaction.payments?.find(
    ({ error_code: errorCode }) => typeof errorCode === 'string',
  )?.error_code;

  return latestErrorCode ?? PADDLE_PAYMENT_FAILED_REASON;
};

const unknownEventOf = (
  rawType: string,
  context: EventContext,
): ProviderEvent => ({ ...context, type: 'unknown', rawType });

const paymentEventOf = (
  eventType: string,
  data: unknown,
  context: EventContext,
): ProviderEvent => {
  const type = PAYMENT_EVENT_TYPES.get(eventType);
  const transaction = paddleTransactionSchema.safeParse(data);
  if (!type || !transaction.success) return unknownEventOf(eventType, context);
  // Subscription transactions wait for the subscription stage.
  if (transaction.data.subscription_id !== null) {
    return unknownEventOf(eventType, context);
  }

  return {
    ...context,
    type,
    purpose: 'one_off',
    reference: referenceOf(transaction.data),
    providerPaymentId: transaction.data.id,
    providerSubscriptionId: null,
    amountMinor: transaction.data.details.totals.total,
    currency: transaction.data.currency_code,
    failureReason: failureReasonOf(type, transaction.data),
  };
};

const refundEventTypeOf = (
  adjustment: PaddleAdjustment,
): ProviderRefundEvent['type'] | null => {
  if (adjustment.action !== 'refund' || adjustment.subscription_id !== null) {
    return null;
  }

  const status = ADJUSTMENT_STATUSES.get(adjustment.status);

  return status ? (REFUND_EVENT_TYPES.get(status) ?? null) : null;
};

const refundEventOf = (
  eventType: string,
  data: unknown,
  context: EventContext,
): ProviderEvent => {
  const adjustment = paddleAdjustmentSchema.safeParse(data);
  const type = adjustment.success ? refundEventTypeOf(adjustment.data) : null;
  if (!adjustment.success || !type) return unknownEventOf(eventType, context);

  return {
    ...context,
    type,
    providerPaymentId: adjustment.data.transaction_id,
    reference: null,
    refundReference: null,
    providerRefundId: adjustment.data.id,
    amountMinor: adjustment.data.totals.total,
    currency: adjustment.data.currency_code,
  };
};

const toProviderEvent = (envelope: PaddleEnvelope): ProviderEvent => {
  const context: EventContext = {
    dedupKey: envelope.event_id,
    occurredAt: occurredAtOf(envelope.occurred_at),
  };

  return ADJUSTMENT_EVENT_TYPES.has(envelope.event_type)
    ? refundEventOf(envelope.event_type, envelope.data, context)
    : paymentEventOf(envelope.event_type, envelope.data, context);
};

const parseJsonOrNull = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export {
  ADJUSTMENT_ID_PATTERN,
  ADJUSTMENT_STATUSES,
  amountMinorOf,
  paddleAdjustmentPageSchema,
  paddleAdjustmentSchema,
  paddleCreatedTransactionSchema,
  paddleEnvelopeSchema,
  paddleErrorBodySchema,
  paddleRefundableTransactionSchema,
  paddleTransactionSchema,
  parseJsonOrNull,
  toProviderEvent,
  TRANSACTION_ID_PATTERN,
  TRANSACTION_STATUSES,
};
export type {
  PaddleAdjustment,
  PaddleRefundableTransaction,
  PaddleTransaction,
};
