import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { PROVIDER_ACCOUNT_STATUSES } from '../../provider-accounts/provider-accounts.constants';
import { PROVIDER_CODES } from '../../providers/provider.constants';

import { projects } from './projects.schema';
import { quotedList } from './schema-helpers';

const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    provider: text('provider', { enum: PROVIDER_CODES }).notNull(),
    status: text('status', { enum: PROVIDER_ACCOUNT_STATUSES })
      .notNull()
      .default('active'),
    credentialsRef: text('credentials_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('provider_accounts_project_id_provider_unique').on(
      table.projectId,
      table.provider,
    ),
    // The target of the composite foreign key that keeps payments.provider and the account's provider equal.
    unique('provider_accounts_id_project_id_provider_unique').on(
      table.id,
      table.projectId,
      table.provider,
    ),
    check(
      'provider_accounts_provider_check',
      sql`${table.provider} IN (${quotedList(PROVIDER_CODES)})`,
    ),
    check(
      'provider_accounts_status_check',
      sql`${table.status} IN (${quotedList(PROVIDER_ACCOUNT_STATUSES)})`,
    ),
    check(
      'provider_accounts_credentials_ref_check',
      sql`${table.credentialsRef} ~ '^env:[A-Z][A-Z0-9_]*$'`,
    ),
  ],
);

type ProviderAccount = typeof providerAccounts.$inferSelect;

export { providerAccounts };
export type { ProviderAccount };
