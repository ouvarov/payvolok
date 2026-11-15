import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects.schema';

const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('api_keys_key_hash_unique').on(table.keyHash),
    index('api_keys_project_id_idx').on(table.projectId),
    check('api_keys_key_hash_check', sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
    check('api_keys_key_prefix_check', sql`${table.keyPrefix} ~ '^pv_test_'`),
  ],
);

type ApiKey = typeof apiKeys.$inferSelect;

export { apiKeys };
export type { ApiKey };
