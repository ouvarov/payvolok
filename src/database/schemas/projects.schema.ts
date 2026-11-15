import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { PROJECT_STATUSES } from '../../projects/projects.constants';

import { quotedList } from './schema-helpers';

const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: PROJECT_STATUSES })
      .notNull()
      .default('active'),
    allowedReturnOrigins: text('allowed_return_origins')
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('projects_slug_unique').on(table.slug),
    check(
      'projects_slug_check',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      'projects_status_check',
      sql`${table.status} IN (${quotedList(PROJECT_STATUSES)})`,
    ),
  ],
);

type Project = typeof projects.$inferSelect;

export { projects };
export type { Project };
