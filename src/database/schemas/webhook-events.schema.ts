import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { PROVIDER_CODES } from '../../providers/provider.constants';
import { WEBHOOK_EVENT_STATUSES } from '../../webhooks/webhook-event.constants';

import { quotedList } from './schema-helpers';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider', { enum: PROVIDER_CODES }).notNull(),
    dedupKey: text('dedup_key').notNull(),
    status: text('status', { enum: WEBHOOK_EVENT_STATUSES }).notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    rawBody: bytea('raw_body'),
    headers: jsonb('headers')
      .$type<Record<string, string | string[]>>()
      .notNull()
      .default({}),
    eventTypes: text('event_types')
      .array()
      .notNull()
      .default(sql`'{}'`),
    paymentIds: uuid('payment_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    failureReason: text('failure_reason'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // Both the retry time and the lease of a worker holding the row.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    replayOf: uuid('replay_of').references((): AnyPgColumn => webhookEvents.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_dedup_key_unique')
      .on(table.provider, table.dedupKey)
      .where(sql`${table.replayOf} IS NULL`),
    index('webhook_events_next_attempt_at_id_idx')
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.status} = 'received'`),
    check(
      'webhook_events_status_check',
      sql`${table.status} IN (${quotedList(WEBHOOK_EVENT_STATUSES)})`,
    ),
    check('webhook_events_attempts_check', sql`${table.attempts} >= 0`),
    check(
      'webhook_events_invalid_signature_ignored_check',
      sql`${table.signatureValid} OR ${table.status} = 'ignored'`,
    ),
    check(
      'webhook_events_raw_body_check',
      sql`(${table.rawBody} IS NOT NULL) = (${table.signatureValid} AND ${table.replayOf} IS NULL)`,
    ),
    check(
      'webhook_events_next_attempt_at_check',
      sql`(${table.status} = 'received') = (${table.nextAttemptAt} IS NOT NULL)`,
    ),
    check(
      'webhook_events_finished_at_check',
      sql`(${table.status} = 'received') = (${table.finishedAt} IS NULL)`,
    ),
  ],
);

type WebhookEvent = typeof webhookEvents.$inferSelect;
type NewWebhookEvent = typeof webhookEvents.$inferInsert;

export { webhookEvents };
export type { NewWebhookEvent, WebhookEvent };
