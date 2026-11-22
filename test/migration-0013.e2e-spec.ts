import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { IDEMPOTENCY_SCOPES } from '@/idempotency/idempotency.constants';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import { migrateToLatest, migrateUpTo } from './migrate-up-to';

const SLOW_TEST_TIMEOUT_MS = 60000;
const CHECK_VIOLATION = '23514';

const migrationSqlOf = (): string => {
  const fileName = readdirSync(MIGRATIONS_FOLDER).find((name) =>
    name.startsWith('0013_'),
  );
  if (!fileName) throw new Error('Migration 0013 is missing');

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

const insertKeySql = (scope: string): string => `
  insert into idempotency_keys (project_id, scope, key, request_hash, status)
  values ('${SEED_PROJECT_ID}', '${scope}', 'migration-0013-${scope}', '${'a'.repeat(64)}', 'in_progress')`;

describe('migration 0013', () => {
  describe('the file', () => {
    const statements = statementsOf(migrationSqlOf());

    it('sets the lock timeout before any other statement', () => {
      expect(statements[0]).toBe("SET LOCAL lock_timeout = '3s';");
    });

    it('drops only the scope check it adds back', () => {
      expect(
        statements.filter((statement) => /\bDROP\b/i.test(statement)),
      ).toEqual([
        'ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_scope_check";',
      ]);
    });
  });

  it(
    'turns a demo scope from a check violation on 0012 into an accepted key',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0012');
        expect(
          await errorCodeOf(database, insertKeySql('demo:create_payment')),
        ).toBe(CHECK_VIOLATION);

        await migrateToLatest(database);

        for (const scope of ['demo:create_payment', 'demo:create_refund']) {
          expect(await errorCodeOf(database, insertKeySql(scope))).toBeNull();
        }
        expect(await errorCodeOf(database, insertKeySql('demo:other'))).toBe(
          CHECK_VIOLATION,
        );
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'leaves a scope check that lists exactly IDEMPOTENCY_SCOPES and the partial demo index',
    () =>
      withDatabase(async (database) => {
        await migrateToLatest(database);

        const {
          rows: [{ definition }],
        } = await database.query<{ definition: string }>(
          `select pg_get_constraintdef(oid) as definition from pg_constraint
           where conname = 'idempotency_keys_scope_check'`,
        );
        const listedScopes = [...definition.matchAll(/'([\w:]+)'/g)].map(
          ([, scope]) => scope,
        );
        const { rows: indexes } = await database.query<{ indexdef: string }>(
          `select indexdef from pg_indexes
           where indexname = 'payments_demo_created_at_idx'`,
        );

        expect(listedScopes.sort()).toEqual([...IDEMPOTENCY_SCOPES].sort());
        expect(indexes).toEqual([
          {
            indexdef: expect.stringMatching(
              /ON public\.payments USING btree \(created_at\) WHERE \(origin = 'demo'::text\)$/,
            ) as string,
          },
        ]);
      }),
    SLOW_TEST_TIMEOUT_MS,
  );
});
