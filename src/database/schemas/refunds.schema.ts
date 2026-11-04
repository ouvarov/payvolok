import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { PAYMENT_ORIGINS } from '../../payments/payment.constants';
import { PROVIDER_CODES } from '../../providers/provider.constants';
import {
  REFUND_STATUSES,
  REFUNDS_PROVIDER_REF_UNIQUE,
} from '../../refunds/refund.constants';

import { payments } from './payments.schema';
import { quotedList } from './schema-helpers';

const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    provider: text('provider', { enum: PROVIDER_CODES }).notNull(),
    providerRefundId: text('provider_refund_id'),
    origin: text('origin', { enum: PAYMENT_ORIGINS }).notNull(),
    status: text('status', { enum: REFUND_STATUSES }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique(REFUNDS_PROVIDER_REF_UNIQUE).on(
      table.provider,
      table.providerRefundId,
    ),
    index('refunds_payment_id_created_at_id_idx').on(
      table.paymentId,
      table.createdAt,
      table.id,
    ),
    check(
      'refunds_origin_check',
      sql`${table.origin} IN (${quotedList(PAYMENT_ORIGINS)})`,
    ),
    check(
      'refunds_status_check',
      sql`${table.status} IN (${quotedList(REFUND_STATUSES)})`,
    ),
    check('refunds_amount_minor_check', sql`${table.amountMinor} > 0`),
    check('refunds_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

type Refund = typeof refunds.$inferSelect;
type NewRefund = typeof refunds.$inferInsert;

export { refunds };
export type { NewRefund, Refund };
