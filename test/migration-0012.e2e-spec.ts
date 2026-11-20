import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import {
  SEED_STRIPE_ACCOUNT_ID,
  SEED_STRIPE_CREDENTIALS_REF,
} from '@/provider-accounts/provider-accounts.constants';
import { PROVIDER_CODES } from '@/providers/provider.constants';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import { migrateToLatest, migrateUpTo } from './migrate-up-to';

const SLOW_TEST_TIMEOUT_MS = 60000;
const CHECK_VIOLATION = '23514';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000d0';

const migrationSqlOf = (): string => {
  const fileName = readdirSync(MIGRATIONS_FOLDER).find((name) =>
    name.startsWith('0012_'),
  );
  if (!fileName) throw new Error('Migration 0012 is missing');

  return readFileSync(join(MIGRATIONS_FOLDER, fileName), 'utf8');
};

const statementsOf = (migrationSql: string): string[] =>
  migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

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

const otherProjectAccountSql = (provider: string): string => `
  insert into provider_accounts (project_id, provider, credentials_ref)
  values ('${OTHER_PROJECT_ID}', '${provider}', 'env:OTHER')`;

const stripeAccountsOf = (database: PGlite) =>
  rowsOf(
    database,
    `select id, project_id, provider, status, credentials_ref
     from provider_accounts where provider = 'stripe'`,
  );

describe('migration 0012', () => {
  describe('the file', () => {
    const statements = statementsOf(migrationSqlOf());

    it('sets the lock timeout before any other statement', () => {
      expect(statements[0]).toBe("SET LOCAL lock_timeout = '3s';");
    });

    it('drops only the provider check it adds back', () => {
      expect(
        statements.filter((statement) => /\bDROP\b/i.test(statement)),
      ).toEqual([
        'ALTER TABLE "provider_accounts" DROP CONSTRAINT "provider_accounts_provider_check";',
      ]);
    });

    it('seeds the account with the ids and credential ref of the constants', () => {
      expect(statements).toContainEqual(
        expect.stringContaining(
          `VALUES ('${SEED_STRIPE_ACCOUNT_ID}'::uuid, '${SEED_PROJECT_ID}'::uuid, 'stripe', 'disabled', '${SEED_STRIPE_CREDENTIALS_REF}')`,
        ),
      );
    });
  });

  it(
    'seeds one disabled Stripe account on the seed project, and a second run inserts nothing',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0011');

        await migrateToLatest(database);

        const expectedAccounts = [
          {
            id: SEED_STRIPE_ACCOUNT_ID,
            project_id: SEED_PROJECT_ID,
            provider: 'stripe',
            status: 'disabled',
            credentials_ref: SEED_STRIPE_CREDENTIALS_REF,
          },
        ];
        expect(await stripeAccountsOf(database)).toEqual(expectedAccounts);

        const changedRows: number[] = [];
        for (const statement of statementsOf(migrationSqlOf())) {
          if (!statement.startsWith('INSERT')) continue;
          changedRows.push((await database.query(statement)).affectedRows ?? 0);
        }
        expect(changedRows).toEqual([0]);
        expect(await stripeAccountsOf(database)).toEqual(expectedAccounts);
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'lets the provider check take stripe and still refuse an unknown provider',
    () =>
      withDatabase(async (database) => {
        await migrateToLatest(database);
        await database.exec(`
          insert into projects (id, slug, name) values ('${OTHER_PROJECT_ID}', 'project-d', 'Project D')`);

        expect(
          await errorCodeOf(database, otherProjectAccountSql('liqpay')),
        ).toBe(CHECK_VIOLATION);
        expect(
          await errorCodeOf(database, otherProjectAccountSql('stripe')),
        ).toBeNull();
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'leaves a check that lists exactly PROVIDER_CODES',
    () =>
      withDatabase(async (database) => {
        await migrateToLatest(database);

        const [{ definition }] = await rowsOf<{ definition: string }>(
          database,
          `select pg_get_constraintdef(oid) as definition from pg_constraint
           where conname = 'provider_accounts_provider_check'`,
        );
        const listedCodes = [...definition.matchAll(/'(\w+)'/g)].map(
          ([, code]) => code,
        );

        expect(listedCodes.sort()).toEqual([...PROVIDER_CODES].sort());
      }),
    SLOW_TEST_TIMEOUT_MS,
  );
});
