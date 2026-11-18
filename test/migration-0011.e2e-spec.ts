import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';

import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import { SEED_PADDLE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import { databaseUrl, describeOnRealPostgres } from './helpers';
import { migrateToLatest, migrateUpTo } from './migrate-up-to';

const SLOW_TEST_TIMEOUT_MS = 60000;
const NOT_NULL_VIOLATION = '23502';
const FOREIGN_KEY_VIOLATION = '23503';
const MIGRATIONS_BEFORE_0011 = 11;

const PADDLE_PAYMENT_ID = '00000000-0000-4000-8000-000000000021';
const PADDLE_REFUND_ID = '00000000-0000-4000-8000-000000000022';
const PADDLE_EVENT_ID = '00000000-0000-4000-8000-000000000023';
const ORPHAN_PAYMENT_ID = '00000000-0000-4000-8000-000000000024';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000c0';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const REQUEST_HASH = 'a'.repeat(64);

const CONTRACT_FOREIGN_KEYS = [
  'idempotency_keys_payment_project_fk',
  'idempotency_keys_project_id_projects_id_fk',
  'payments_project_id_projects_id_fk',
  'payments_provider_account_fk',
  'refunds_payment_project_account_fk',
  'webhook_events_provider_account_fk',
  'webhook_events_provider_account_id_provider_accounts_id_fk',
];

// What a process still running older code writes between 0010 and 0011: no account.
const windowRowsSql = `
  insert into payments (id, provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
  values ('${PADDLE_PAYMENT_ID}', 'paddle', 'txn_contract', 'one_off', 'api', 'succeeded', 1000, 'USD');
  insert into refunds (id, payment_id, provider, provider_refund_id, origin, status, amount_minor, currency)
  values ('${PADDLE_REFUND_ID}', '${PADDLE_PAYMENT_ID}', 'paddle', 'adj_contract', 'api', 'pending', 300, 'USD');
  insert into webhook_events (id, provider, dedup_key, status, signature_valid, finished_at)
  values ('${PADDLE_EVENT_ID}', 'paddle', 'invalid:contract', 'ignored', false, clock_timestamp());
`;

const otherProjectSql = `
  insert into projects (id, slug, name) values ('${OTHER_PROJECT_ID}', 'project-c', 'Project C');
  insert into provider_accounts (id, project_id, provider, credentials_ref)
  values ('${OTHER_ACCOUNT_ID}', '${OTHER_PROJECT_ID}', 'paddle', 'env:PADDLE_C');
`;

// A project with no Paddle account: the backfill has nothing to give this row.
const orphanRowSql = `
  insert into projects (id, slug, name) values ('${OTHER_PROJECT_ID}', 'project-c', 'Project C');
  insert into payments (id, project_id, provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
  values ('${ORPHAN_PAYMENT_ID}', '${OTHER_PROJECT_ID}', 'paddle', 'txn_orphan', 'one_off', 'api', 'succeeded', 1000, 'USD');
`;

type QueryRows = <T>(query: string) => Promise<T[]>;

const migrationSqlOf = (migrationNumber: string): string => {
  const fileName = readdirSync(MIGRATIONS_FOLDER).find((name) =>
    name.startsWith(`${migrationNumber}_`),
  );
  if (!fileName) throw new Error(`Migration ${migrationNumber} is missing`);

  return readFileSync(join(MIGRATIONS_FOLDER, fileName), 'utf8');
};

const statementsOf = (migrationSql: string): string[] =>
  migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

const dataStatementsOf = (statements: readonly string[]): string[] =>
  statements.filter((statement) => /^(INSERT|UPDATE)\b/.test(statement));

const notValidForeignKeysOf = (migrationSql: string): string[] =>
  [...migrationSql.matchAll(/ADD CONSTRAINT "(\w+)" FOREIGN KEY .* NOT VALID/g)]
    .map(([, name]) => name)
    .sort();

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

const queryRowsOf =
  (database: PGlite): QueryRows =>
  async <T>(query: string) =>
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

const foreignKeysOf = (rowsOf: QueryRows) =>
  rowsOf<{ conname: string; convalidated: boolean }>(`
    select conname, convalidated from pg_constraint
    where conname in (${CONTRACT_FOREIGN_KEYS.map((name) => `'${name}'`).join(', ')})
    order by conname`);

const retiredKeysOf = (rowsOf: QueryRows) =>
  rowsOf<{ name: string }>(`
    select conname::text as name from pg_constraint
    where conname in ('payments_provider_provider_payment_id_unique', 'refunds_provider_provider_refund_id_unique', 'idempotency_keys_scope_key_pk')
    union all
    select indexname::text from pg_indexes
    where indexname in ('webhook_events_provider_dedup_key_unique', 'idempotency_keys_project_id_scope_key_unique')`);

const idempotencyPrimaryKeyOf = (rowsOf: QueryRows) =>
  rowsOf<{ conname: string; columns: string[] }>(`
    select c.conname,
      array(
        select a.attname::text
        from unnest(c.conkey) with ordinality as k(attnum, position)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        order by k.position
      ) as columns
    from pg_constraint c
    where c.conrelid = 'idempotency_keys'::regclass and c.contype = 'p'`);

const providerRefIndexOf = (rowsOf: QueryRows) =>
  rowsOf<{ indexdef: string }>(`
    select indexdef from pg_indexes
    where indexname = 'payments_provider_provider_payment_id_idx'`);

const expectContractCatalog = async (rowsOf: QueryRows): Promise<void> => {
  expect(await foreignKeysOf(rowsOf)).toEqual(
    CONTRACT_FOREIGN_KEYS.map((conname) => ({ conname, convalidated: true })),
  );
  expect(await retiredKeysOf(rowsOf)).toEqual([]);
  expect(await idempotencyPrimaryKeyOf(rowsOf)).toEqual([
    {
      conname: 'idempotency_keys_project_id_scope_key_pk',
      columns: ['project_id', 'scope', 'key'],
    },
  ]);
  const [providerRefIndex] = await providerRefIndexOf(rowsOf);
  expect(providerRefIndex?.indexdef).toMatch(
    /\(provider, provider_payment_id\) WHERE \(provider_payment_id IS NOT NULL\)/,
  );
};

describe('migration 0011', () => {
  describe('the file', () => {
    const statements = statementsOf(migrationSqlOf('0011'));

    it('sets the lock timeout before any other statement', () => {
      expect(statements[0]).toBe("SET LOCAL lock_timeout = '3s';");
    });

    it('repeats the 0010 account fill before it changes any column', () => {
      const repeatedFill = dataStatementsOf(
        statementsOf(migrationSqlOf('0010')),
      );

      expect(statements.slice(1, 1 + repeatedFill.length)).toEqual(
        repeatedFill,
      );
      expect(dataStatementsOf(statements)).toEqual(repeatedFill);
    });

    it('validates every NOT VALID foreign key of 0009 and 0010', () => {
      const validated = statements
        .map((statement) => /VALIDATE CONSTRAINT "(\w+)"/.exec(statement)?.[1])
        .filter((name) => name !== undefined)
        .sort();

      expect(validated).toEqual(
        [
          ...notValidForeignKeysOf(migrationSqlOf('0009')),
          ...notValidForeignKeysOf(migrationSqlOf('0010')),
        ].sort(),
      );
      expect(validated).toEqual(CONTRACT_FOREIGN_KEYS);
    });
  });

  it(
    'gives rows written after 0010 without an account their seed account',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0010');
        await database.exec(windowRowsSql);

        await migrateToLatest(database);

        expect(
          await queryRowsOf(database)(`
            select 'payments' as source, provider_account_id from payments
            union all select 'refunds', provider_account_id from refunds
            union all select 'webhook_events', provider_account_id from webhook_events
            order by source`),
        ).toEqual(
          ['payments', 'refunds', 'webhook_events'].map((source) => ({
            source,
            provider_account_id: SEED_PADDLE_ACCOUNT_ID,
          })),
        );
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  describe('after it', () => {
    const paymentSql = (columns: Record<string, string>): string => {
      const row: Record<string, string> = {
        id: `'${PADDLE_PAYMENT_ID}'`,
        provider: `'paddle'`,
        purpose: `'one_off'`,
        origin: `'api'`,
        status: `'succeeded'`,
        amount_minor: '1000',
        currency: `'USD'`,
        ...columns,
      };

      return `insert into payments (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`;
    };

    const refundSql = (columns: Record<string, string>): string => {
      const row: Record<string, string> = {
        payment_id: `'${PADDLE_PAYMENT_ID}'`,
        provider: `'paddle'`,
        provider_refund_id: 'gen_random_uuid()::text',
        origin: `'api'`,
        status: `'pending'`,
        amount_minor: '100',
        currency: `'USD'`,
        ...columns,
      };

      return `insert into refunds (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`;
    };

    const keySql = (columns: Record<string, string>): string => {
      const row: Record<string, string> = {
        scope: `'api:create_refund'`,
        key: 'gen_random_uuid()::text',
        request_hash: `'${REQUEST_HASH}'`,
        status: `'in_progress'`,
        ...columns,
      };

      return `insert into idempotency_keys (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`;
    };

    const webhookSql = (columns: Record<string, string>): string => {
      const row: Record<string, string> = {
        provider: `'paddle'`,
        dedup_key: 'gen_random_uuid()::text',
        status: `'ignored'`,
        signature_valid: 'false',
        finished_at: 'clock_timestamp()',
        ...columns,
      };

      return `insert into webhook_events (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`;
    };

    const seedProject = { project_id: `'${SEED_PROJECT_ID}'` };
    const seedAccount = { provider_account_id: `'${SEED_PADDLE_ACCOUNT_ID}'` };

    it(
      'refuses a row without its account or project, and a refund of another project',
      () =>
        withDatabase(async (database) => {
          await migrateToLatest(database);
          await database.exec(otherProjectSql);
          await database.exec(paymentSql({ ...seedProject, ...seedAccount }));

          expect(
            await errorCodeOf(
              database,
              paymentSql({ id: 'gen_random_uuid()', ...seedProject }),
            ),
          ).toBe(NOT_NULL_VIOLATION);
          expect(
            await errorCodeOf(
              database,
              paymentSql({ id: 'gen_random_uuid()', ...seedAccount }),
            ),
          ).toBe(NOT_NULL_VIOLATION);
          expect(await errorCodeOf(database, refundSql(seedProject))).toBe(
            NOT_NULL_VIOLATION,
          );
          expect(await errorCodeOf(database, refundSql(seedAccount))).toBe(
            NOT_NULL_VIOLATION,
          );
          expect(
            await errorCodeOf(
              database,
              refundSql({
                project_id: `'${OTHER_PROJECT_ID}'`,
                provider_account_id: `'${OTHER_ACCOUNT_ID}'`,
              }),
            ),
          ).toBe(FOREIGN_KEY_VIOLATION);
          expect(await errorCodeOf(database, keySql({}))).toBe(
            NOT_NULL_VIOLATION,
          );
          expect(await errorCodeOf(database, webhookSql({}))).toBe(
            NOT_NULL_VIOLATION,
          );

          for (const statement of [
            refundSql({ ...seedProject, ...seedAccount }),
            keySql(seedProject),
            webhookSql(seedAccount),
          ]) {
            expect(await errorCodeOf(database, statement)).toBeNull();
          }
        }),
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'validates the 3.5 foreign keys, drops the per-provider keys and keys idempotency by project',
      () =>
        withDatabase(async (database) => {
          await migrateUpTo(database, '0010');
          await database.exec(windowRowsSql);

          await migrateToLatest(database);

          await expectContractCatalog(queryRowsOf(database));
        }),
      SLOW_TEST_TIMEOUT_MS,
    );
  });

  it(
    'fails on a row the fill cannot give an account and rolls back the whole migration',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0010');
        await database.exec(windowRowsSql + orphanRowSql);
        const rowsOf = queryRowsOf(database);

        await expect(migrateToLatest(database)).rejects.toThrow();

        expect(
          await rowsOf(
            'select count(*)::int as applied from drizzle.__drizzle_migrations',
          ),
        ).toEqual([{ applied: MIGRATIONS_BEFORE_0011 }]);
        expect(
          await rowsOf(`
            select
              (select count(*) from payments where provider_account_id is null)::int as payments,
              (select count(*) from refunds where provider_account_id is null)::int as refunds,
              (select count(*) from webhook_events where provider_account_id is null)::int as webhook_events`),
        ).toEqual([{ payments: 2, refunds: 1, webhook_events: 1 }]);
        expect(
          await rowsOf(`
            select table_name, column_name, is_nullable, column_default is not null as has_default
            from information_schema.columns
            where table_schema = 'public'
              and (table_name, column_name) in (
                ('payments', 'provider_account_id'),
                ('payments', 'project_id'),
                ('idempotency_keys', 'project_id')
              )
            order by table_name, column_name`),
        ).toEqual([
          {
            table_name: 'idempotency_keys',
            column_name: 'project_id',
            is_nullable: 'NO',
            has_default: true,
          },
          {
            table_name: 'payments',
            column_name: 'project_id',
            is_nullable: 'NO',
            has_default: true,
          },
          {
            table_name: 'payments',
            column_name: 'provider_account_id',
            is_nullable: 'YES',
            has_default: false,
          },
        ]);
        expect(await retiredKeysOf(rowsOf)).toHaveLength(5);
        expect(await providerRefIndexOf(rowsOf)).toEqual([]);
        expect(await foreignKeysOf(rowsOf)).toEqual(
          CONTRACT_FOREIGN_KEYS.map((conname) => ({
            conname,
            convalidated: false,
          })),
        );
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  describeOnRealPostgres('on the e2e Postgres', () => {
    it('leaves the contract catalog the migrator applied', async () => {
      const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

      try {
        await expectContractCatalog(
          async <T>(query: string) =>
            (await client.unsafe(query)) as unknown as T[],
        );
      } finally {
        await client.end();
      }
    });
  });
});
