import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  PAYMENT_EVENT_OUTCOMES,
  PAYMENT_ORIGINS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  PAYMENTS_PROVIDER_REF_UNIQUE,
  RECONCILABLE_PAYMENT_STATUSES,
  RECONCILE_GRACE_SECONDS,
} from '../../payments/payment.constants';
import { PROVIDER_CODES } from '../../providers/provider.constants';

import { quotedList } from './schema-helpers';
import { webhookEvents } from './webhook-events.schema';

const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider', { enum: PROVIDER_CODES }).notNull(),
    providerPaymentId: text('provider_payment_id'),
    purpose: text('purpose', { enum: PAYMENT_PURPOSES }).notNull(),
    origin: text('origin', { enum: PAYMENT_ORIGINS }).notNull(),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    // Volatile on purpose: adding the column then rewrites the table and sets every existing row due after the grace.
    reconcileAfter: timestamp('reconcile_after', {
      withTimezone: true,
    }).default(
      sql.raw(
        `(clock_timestamp() + interval '${RECONCILE_GRACE_SECONDS} seconds')`,
      ),
    ),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  },
  (table) => [
    unique(PAYMENTS_PROVIDER_REF_UNIQUE).on(
      table.provider,
      table.providerPaymentId,
    ),
    check(
      'payments_purpose_check',
      sql`${table.purpose} IN (${quotedList(PAYMENT_PURPOSES)})`,
    ),
    check(
      'payments_origin_check',
      sql`${table.origin} IN (${quotedList(PAYMENT_ORIGINS)})`,
    ),
    check(
      'payments_status_check',
      sql`${table.status} IN (${quotedList(PAYMENT_STATUSES)})`,
    ),
    check('payments_amount_minor_check', sql`${table.amountMinor} >= 0`),
    check('payments_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'payments_reconcile_attempts_check',
      sql`${table.reconcileAttempts} >= 0`,
    ),
    index('payments_reconcile_after_idx')
      .on(table.reconcileAfter)
      .where(
        sql`${table.status} IN (${quotedList(RECONCILABLE_PAYMENT_STATUSES)})`,
      ),
  ],
);

const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    fromStatus: text('from_status', { enum: PAYMENT_STATUSES }),
    toStatus: text('to_status', { enum: PAYMENT_STATUSES }).notNull(),
    outcome: text('outcome', { enum: PAYMENT_EVENT_OUTCOMES }).notNull(),
    reason: text('reason').notNull(),
    webhookEventId: uuid('webhook_event_id').references(() => webhookEvents.id),
    // Not now(): that is the transaction start, which can precede a concurrent
    // transaction that won the row lock first and so misorder the timeline.
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('payment_events_webhook_event_id_payment_id_to_status_unique').on(
      table.webhookEventId,
      table.paymentId,
      table.toStatus,
    ),
    index('payment_events_payment_id_created_at_id_idx').on(
      table.paymentId,
      table.createdAt,
      table.id,
    ),
    check(
      'payment_events_from_status_check',
      sql`${table.fromStatus} IN (${quotedList(PAYMENT_STATUSES)})`,
    ),
    check(
      'payment_events_to_status_check',
      sql`${table.toStatus} IN (${quotedList(PAYMENT_STATUSES)})`,
    ),
    check(
      'payment_events_outcome_check',
      sql`${table.outcome} IN (${quotedList(PAYMENT_EVENT_OUTCOMES)})`,
    ),
  ],
);

type Payment = typeof payments.$inferSelect;
type NewPayment = typeof payments.$inferInsert;
type PaymentEvent = typeof paymentEvents.$inferSelect;
type NewPaymentEvent = typeof paymentEvents.$inferInsert;

export { paymentEvents, payments };
export type { NewPayment, NewPaymentEvent, Payment, PaymentEvent };
