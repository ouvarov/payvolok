import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_FAKE_CREDENTIALS_REF,
  SEED_PADDLE_ACCOUNT_ID,
} from '@/provider-accounts/provider-accounts.constants';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import { migrateToLatest, migrateUpTo } from './migrate-up-to';

const SLOW_TEST_TIMEOUT_MS = 60000;
const FOREIGN_KEY_VIOLATION = '23503';

const PADDLE_PAYMENT_ID = '00000000-0000-4000-8000-000000000011';
const FAKE_PAYMENT_ID = '00000000-0000-4000-8000-000000000012';
const PADDLE_REFUND_ID = '00000000-0000-4000-8000-000000000013';
const PADDLE_EVENT_ID = '00000000-0000-4000-8000-000000000014';
const FAKE_EVENT_ID = '00000000-0000-4000-8000-000000000015';

// What the code before 3.5a writes after 0009 is applied: no account on any row.
const windowRowsSql = `
  insert into payments (id, provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
  values ('${PADDLE_PAYMENT_ID}', 'paddle', 'txn_window', 'one_off', 'api', 'succeeded', 1000, 'USD');
  insert into refunds (id, payment_id, provider, provider_refund_id, origin, status, amount_minor, currency)
  values ('${PADDLE_REFUND_ID}', '${PADDLE_PAYMENT_ID}', 'paddle', 'adj_window', 'api', 'pending', 300, 'USD');
  insert into webhook_events (id, provider, dedup_key, status, signature_valid, finished_at)
  values ('${PADDLE_EVENT_ID}', 'paddle', 'invalid:window', 'ignored', false, clock_timestamp());
`;

const fakeWindowRowsSql = `
  insert into payments (id, provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
  values ('${FAKE_PAYMENT_ID}', 'fake', 'fake_window', 'one_off', 'api', 'succeeded', 2000, 'USD');
  insert into webhook_events (id, provider, dedup_key, status, signature_valid, finished_at)
  values ('${FAKE_EVENT_ID}', 'fake', 'invalid:fake_window', 'ignored', false, clock_timestamp());
`;

const migrationSqlOf = (): string => {
  const fileName = readdirSync(MIGRATIONS_FOLDER).find((name) =>
    name.startsWith('0010_'),
  );
  if (!fileName) throw new Error('Migration 0010 is missing');

  return readFileSync(join(MIGRATIONS_FOLDER, fileName), 'utf8');
};

const statementsOf = (migrationSql: string): string[] =>
  migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

const dataStatementsOf = (statements: readonly string[]): string[] =>
  statements.filter((statement) => /^(INSERT|UPDATE)\b/.test(statement));

const withDatabase = async (
  work: (database: PGlite) => Promise<void>,
): Promise<void> => {
  const database = new PGlite();

  try {
    await work(database);
  } finally {
    await database.close();
  }
};

const rowsOf = async <T>(database: PGlite, query: string): Promise<T[]> =>
  (await database.query<T>(query)).rows;

const accountIdsOf = (
  database: PGlite,
  table: 'payments' | 'refunds' | 'webhook_events',
): Promise<{ id: string; provider_account_id: string | null }[]> =>
  rowsOf(database, `select id, provider_account_id from ${table} order by id`);

const errorCodeOf = async (
  database: PGlite,
  statement: string,
): Promise<string | null> => {
  try {
    await database.query(statement);

    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
};

const webhookRowSql = (provider: string, accountId: string): string => `
  insert into webhook_events (provider, provider_account_id, dedup_key, status, signature_valid, finished_at)
  values ('${provider}', '${accountId}', gen_random_uuid()::text, 'ignored', false, clock_timestamp())`;

describe('migration 0010', () => {
  describe('the file', () => {
    const statements = statementsOf(migrationSqlOf());

    it('sets the lock timeout before any other statement', () => {
      expect(statements[0]).toBe("SET LOCAL lock_timeout = '3s';");
    });

    it('drops nothing', () => {
      for (const statement of statements) {
        expect(statement).not.toMatch(/\bDROP\b/i);
      }
    });

    it('adds the provider-matching webhook foreign key as NOT VALID', () => {
      const foreignKeys = statements.filter((statement) =>
        /FOREIGN KEY/.test(statement),
      );

      expect(foreignKeys).toEqual([
        expect.stringMatching(
          /^ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_account_fk" FOREIGN KEY \("provider_account_id","provider"\) REFERENCES "public"\."provider_accounts"\("id","provider"\) .* NOT VALID;$/,
        ),
      ]);
    });

    it('uses the same seed ids and fake credential ref as the constants', () => {
      const migrationSql = migrationSqlOf();

      expect(
        new Set(
          migrationSql.match(
            /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g,
          ),
        ),
      ).toEqual(
        new Set([SEED_PROJECT_ID, SEED_FAKE_ACCOUNT_ID].map((id) => `'${id}'`)),
      );
      expect(migrationSql).toContain(
        `SELECT '${SEED_FAKE_ACCOUNT_ID}'::uuid, '${SEED_PROJECT_ID}'::uuid, 'fake', '${SEED_FAKE_CREDENTIALS_REF}'`,
      );
    });
  });

  it(
    'gives rows written without an account their seed account, and a second run changes nothing',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0009');
        await database.exec(windowRowsSql + fakeWindowRowsSql);

        await migrateToLatest(database);

        expect(await accountIdsOf(database, 'payments')).toEqual([
          {
            id: PADDLE_PAYMENT_ID,
            provider_account_id: SEED_PADDLE_ACCOUNT_ID,
          },
          { id: FAKE_PAYMENT_ID, provider_account_id: SEED_FAKE_ACCOUNT_ID },
        ]);
        expect(await accountIdsOf(database, 'refunds')).toEqual([
          { id: PADDLE_REFUND_ID, provider_account_id: SEED_PADDLE_ACCOUNT_ID },
        ]);
        expect(await accountIdsOf(database, 'webhook_events')).toEqual([
          { id: PADDLE_EVENT_ID, provider_account_id: SEED_PADDLE_ACCOUNT_ID },
          { id: FAKE_EVENT_ID, provider_account_id: SEED_FAKE_ACCOUNT_ID },
        ]);

        const changedRows: number[] = [];
        for (const statement of dataStatementsOf(
          statementsOf(migrationSqlOf()),
        )) {
          changedRows.push((await database.query(statement)).affectedRows ?? 0);
        }
        expect(changedRows).toEqual([0, 0, 0, 0]);
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'creates no fake account on a database with only Paddle rows',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0009');
        await database.exec(windowRowsSql);

        await migrateToLatest(database);

        expect(
          await rowsOf(
            database,
            'select provider from provider_accounts order by provider',
          ),
        ).toEqual([{ provider: 'paddle' }]);
        expect(
          await rowsOf(
            database,
            `select
              (select count(*) from payments where provider_account_id is null)::int as payments,
              (select count(*) from refunds where provider_account_id is null)::int as refunds,
              (select count(*) from webhook_events where provider_account_id is null)::int as webhook_events`,
          ),
        ).toEqual([{ payments: 0, refunds: 0, webhook_events: 0 }]);
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a webhook row whose provider is not its account provider',
    () =>
      withDatabase(async (database) => {
        await migrateToLatest(database);
        await database.exec(`
          insert into provider_accounts (id, project_id, provider, credentials_ref)
          values ('${SEED_FAKE_ACCOUNT_ID}', '${SEED_PROJECT_ID}', 'fake', 'env:FAKE')`);

        expect(
          await errorCodeOf(
            database,
            webhookRowSql('paddle', SEED_PADDLE_ACCOUNT_ID),
          ),
        ).toBeNull();
        expect(
          await errorCodeOf(
            database,
            webhookRowSql('fake', SEED_FAKE_ACCOUNT_ID),
          ),
        ).toBeNull();
        expect(
          await errorCodeOf(
            database,
            webhookRowSql('fake', SEED_PADDLE_ACCOUNT_ID),
          ),
        ).toBe(FOREIGN_KEY_VIOLATION);
      }),
    SLOW_TEST_TIMEOUT_MS,
  );
});
