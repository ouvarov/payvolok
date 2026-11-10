import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  IDEMPOTENCY_KEY_STATUSES,
  IDEMPOTENCY_SCOPES,
} from '../../idempotency/idempotency.constants';

import { payments } from './payments.schema';
import { quotedList } from './schema-helpers';

const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope', { enum: IDEMPOTENCY_SCOPES }).notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: IDEMPOTENCY_KEY_STATUSES }).notNull(),
    paymentId: uuid('payment_id').references(() => payments.id),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<object>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key] }),
    index('idempotency_keys_payment_id_in_progress_idx')
      .on(table.paymentId)
      .where(sql`${table.status} = 'in_progress'`),
    check(
      'idempotency_keys_scope_check',
      sql`${table.scope} IN (${quotedList(IDEMPOTENCY_SCOPES)})`,
    ),
    check(
      'idempotency_keys_status_check',
      sql`${table.status} IN (${quotedList(IDEMPOTENCY_KEY_STATUSES)})`,
    ),
    check(
      'idempotency_keys_request_hash_check',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'idempotency_keys_response_status_check',
      sql`(${table.status} = 'completed') = (${table.responseStatus} IS NOT NULL)`,
    ),
    check(
      'idempotency_keys_response_body_check',
      sql`(${table.status} = 'completed') = (${table.responseBody} IS NOT NULL)`,
    ),
    check(
      'idempotency_keys_completed_at_check',
      sql`(${table.status} = 'completed') = (${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

export { idempotencyKeys };
export type { IdempotencyKey };
