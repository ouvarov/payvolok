import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import {
  SEED_PROJECT_ID,
  SEED_PROJECT_NAME,
  SEED_PROJECT_SLUG,
} from '@/projects/projects.constants';
import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_FAKE_CREDENTIALS_REF,
  SEED_PADDLE_ACCOUNT_ID,
  SEED_PADDLE_CREDENTIALS_REF,
} from '@/provider-accounts/provider-accounts.constants';

import { MIGRATIONS_FOLDER } from './apply-migrations';
import { migrateToLatest, migrateUpTo } from './migrate-up-to';

const SLOW_TEST_TIMEOUT_MS = 60000;
const FOREIGN_KEY_VIOLATION = '23503';

const PADDLE_PAYMENT_ID = '00000000-0000-4000-8000-000000000001';
const FAKE_PAYMENT_ID = '00000000-0000-4000-8000-000000000002';
const PADDLE_REFUND_ID = '00000000-0000-4000-8000-000000000003';
const FAKE_REFUND_ID = '00000000-0000-4000-8000-000000000004';
const DELIVERED_EVENT_ID = '00000000-0000-4000-8000-000000000005';
const INVALID_EVENT_ID = '00000000-0000-4000-8000-000000000006';
const REPLAY_EVENT_ID = '00000000-0000-4000-8000-000000000007';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000b0';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000b1';
const REQUEST_HASH = 'a'.repeat(64);

const paddlePaymentRowsSql = `
  insert into payments (id, provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
  values ('${PADDLE_PAYMENT_ID}', 'paddle', 'txn_legacy', 'one_off', 'api', 'partially_refunded', 1000, 'USD');
  insert into refunds (id, payment_id, provider, provider_refund_id, origin, status, amount_minor, currency)
  values ('${PADDLE_REFUND_ID}', '${PADDLE_PAYMENT_ID}', 'paddle', 'adj_legacy', 'api', 'succeeded', 300, 'USD');
  insert into idempotency_keys (scope, key, request_hash, status, payment_id)
  values ('api:create_payment', 'legacy-key', '${REQUEST_HASH}', 'in_progress', '${PADDLE_PAYMENT_ID}');
  insert into webhook_events (id, provider, dedup_key, status, signature_valid, raw_body, attempts, finished_at)
  values ('${DELIVERED_EVENT_ID}', 'paddle', 'evt_legacy', 'processed', true, '\\x7b7d', 1, clock_timestamp());
  insert into webhook_events (id, provider, dedup_key, status, signature_valid, finished_at)
  values ('${INVALID_EVENT_ID}', 'paddle', 'invalid:legacy', 'ignored', false, clock_timestamp());
  insert into webhook_events (id, provider, dedup_key, status, signature_valid, replay_of, next_attempt_at)
  values ('${REPLAY_EVENT_ID}', 'paddle', 'evt_legacy', 'received', true, '${DELIVERED_EVENT_ID}', clock_timestamp());
`;

const fakePaymentRowsSql = `
  insert into payments (id, provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
  values ('${FAKE_PAYMENT_ID}', 'fake', 'fake_legacy', 'one_off', 'api', 'succeeded', 2000, 'USD');
  insert into refunds (id, payment_id, provider, provider_refund_id, origin, status, amount_minor, currency)
  values ('${FAKE_REFUND_ID}', '${FAKE_PAYMENT_ID}', 'fake', 'fake_refund_legacy', 'api', 'pending', 500, 'USD');
`;

const snapshotSql = `
  create table snapshot_payments as
    select id, status, created_at, updated_at, reconcile_after, reconciled_at from payments;
  create table snapshot_refunds as
    select id, status, created_at, updated_at from refunds;
  create table snapshot_webhook_events as
    select id, status, created_at, next_attempt_at, finished_at from webhook_events;
`;

type AccountRow = {
  id: string;
  project_id: string;
  provider: string;
  status: string;
  credentials_ref: string;
};

const migrationSqlOf = (): string => {
  const fileName = readdirSync(MIGRATIONS_FOLDER).find((name) =>
    name.startsWith('0009_'),
  );
  if (!fileName) throw new Error('Migration 0009 is missing');

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

const accountsOf = (database: PGlite): Promise<AccountRow[]> =>
  rowsOf<AccountRow>(
    database,
    'select id, project_id, provider, status, credentials_ref from provider_accounts order by provider',
  );

const accountIdsOf = (
  database: PGlite,
  table: 'payments' | 'refunds' | 'webhook_events',
): Promise<{ id: string; provider_account_id: string | null }[]> =>
  rowsOf(database, `select id, provider_account_id from ${table} order by id`);

const projectIdsOf = (
  database: PGlite,
  table: 'payments' | 'refunds' | 'idempotency_keys',
): Promise<{ project_id: string }[]> =>
  rowsOf(database, `select project_id from ${table}`);

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

const insertedCountOf = async (
  database: PGlite,
  statement: string,
): Promise<number> => (await database.query(statement)).rows.length;

describe('migration 0009', () => {
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

    it('adds every foreign key on an existing table as NOT VALID', () => {
      const existingTableForeignKeys = statements.filter((statement) =>
        /^ALTER TABLE "(payments|refunds|idempotency_keys|webhook_events)" ADD CONSTRAINT "\w+" FOREIGN KEY/.test(
          statement,
        ),
      );

      expect(existingTableForeignKeys).toHaveLength(6);
      for (const statement of existingTableForeignKeys) {
        expect(statement).toMatch(/ NOT VALID;?$/);
      }
    });

    it('seeds the same ids, slug, name and credential refs as the constants', () => {
      const migrationSql = migrationSqlOf();
      const uuidLiterals = new Set(
        migrationSql.match(
          /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g,
        ),
      );

      expect(uuidLiterals).toEqual(
        new Set(
          [SEED_PROJECT_ID, SEED_PADDLE_ACCOUNT_ID, SEED_FAKE_ACCOUNT_ID].map(
            (id) => `'${id}'`,
          ),
        ),
      );
      expect(migrationSql).toContain(
        `VALUES ('${SEED_PROJECT_ID}', '${SEED_PROJECT_SLUG}', '${SEED_PROJECT_NAME}')`,
      );
      expect(migrationSql).toContain(
        `VALUES ('${SEED_PADDLE_ACCOUNT_ID}', '${SEED_PROJECT_ID}', 'paddle', '${SEED_PADDLE_CREDENTIALS_REF}')`,
      );
      expect(migrationSql).toContain(
        `SELECT '${SEED_FAKE_ACCOUNT_ID}'::uuid, '${SEED_PROJECT_ID}'::uuid, 'fake', '${SEED_FAKE_CREDENTIALS_REF}'`,
      );
    });
  });

  it(
    'gives every legacy row its provider seed account and the seed project',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0008');
        await database.exec(paddlePaymentRowsSql + fakePaymentRowsSql);

        await migrateToLatest(database);

        expect(await accountsOf(database)).toEqual([
          {
            id: SEED_FAKE_ACCOUNT_ID,
            project_id: SEED_PROJECT_ID,
            provider: 'fake',
            status: 'active',
            credentials_ref: SEED_FAKE_CREDENTIALS_REF,
          },
          {
            id: SEED_PADDLE_ACCOUNT_ID,
            project_id: SEED_PROJECT_ID,
            provider: 'paddle',
            status: 'active',
            credentials_ref: SEED_PADDLE_CREDENTIALS_REF,
          },
        ]);
        expect(await accountIdsOf(database, 'payments')).toEqual([
          {
            id: PADDLE_PAYMENT_ID,
            provider_account_id: SEED_PADDLE_ACCOUNT_ID,
          },
          { id: FAKE_PAYMENT_ID, provider_account_id: SEED_FAKE_ACCOUNT_ID },
        ]);
        expect(await accountIdsOf(database, 'refunds')).toEqual([
          { id: PADDLE_REFUND_ID, provider_account_id: SEED_PADDLE_ACCOUNT_ID },
          { id: FAKE_REFUND_ID, provider_account_id: SEED_FAKE_ACCOUNT_ID },
        ]);
        expect(await accountIdsOf(database, 'webhook_events')).toEqual(
          [DELIVERED_EVENT_ID, INVALID_EVENT_ID, REPLAY_EVENT_ID].map((id) => ({
            id,
            provider_account_id: SEED_PADDLE_ACCOUNT_ID,
          })),
        );
        for (const table of [
          'payments',
          'refunds',
          'idempotency_keys',
        ] as const) {
          const projectIds = await projectIdsOf(database, table);
          expect(projectIds.length).toBeGreaterThan(0);
          expect(projectIds).toEqual(
            projectIds.map(() => ({ project_id: SEED_PROJECT_ID })),
          );
        }
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'creates one project and only the Paddle account on a database like production',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0008');
        await database.exec(paddlePaymentRowsSql);

        await migrateToLatest(database);

        expect(
          await rowsOf(database, 'select id, slug, name, status from projects'),
        ).toEqual([
          {
            id: SEED_PROJECT_ID,
            slug: SEED_PROJECT_SLUG,
            name: SEED_PROJECT_NAME,
            status: 'active',
          },
        ]);
        expect(await accountsOf(database)).toEqual([
          {
            id: SEED_PADDLE_ACCOUNT_ID,
            project_id: SEED_PROJECT_ID,
            provider: 'paddle',
            status: 'active',
            credentials_ref: SEED_PADDLE_CREDENTIALS_REF,
          },
        ]);
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
    'changes no status or time of an existing row',
    () =>
      withDatabase(async (database) => {
        await migrateUpTo(database, '0008');
        await database.exec(paddlePaymentRowsSql + fakePaymentRowsSql);
        await database.exec(snapshotSql);

        await migrateToLatest(database);

        expect(
          await rowsOf(
            database,
            `select
              (select count(*) from payments p join snapshot_payments s using (id)
                where (p.status, p.created_at, p.updated_at, p.reconcile_after, p.reconciled_at)
                  is not distinct from (s.status, s.created_at, s.updated_at, s.reconcile_after, s.reconciled_at))::int as payments,
              (select count(*) from refunds r join snapshot_refunds s using (id)
                where (r.status, r.created_at, r.updated_at)
                  is not distinct from (s.status, s.created_at, s.updated_at))::int as refunds,
              (select count(*) from webhook_events w join snapshot_webhook_events s using (id)
                where (w.status, w.created_at, w.next_attempt_at, w.finished_at)
                  is not distinct from (s.status, s.created_at, s.next_attempt_at, s.finished_at))::int as webhook_events`,
          ),
        ).toEqual([{ payments: 2, refunds: 2, webhook_events: 3 }]);
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    'still takes the inserts and conflict targets of the code before it',
    () =>
      withDatabase(async (database) => {
        await migrateToLatest(database);
        const insertPayment = `
          insert into payments (provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
          values ('paddle', 'txn_old_code', 'one_off', 'api', 'succeeded', 1000, 'USD')
          on conflict (provider, provider_payment_id) do nothing
          returning id`;

        expect(await insertedCountOf(database, insertPayment)).toBe(1);
        expect(await insertedCountOf(database, insertPayment)).toBe(0);

        const [{ id: paymentId }] = await rowsOf<{ id: string }>(
          database,
          `select id from payments where provider_payment_id = 'txn_old_code'`,
        );
        const insertRefund = `
          insert into refunds (payment_id, provider, provider_refund_id, origin, status, amount_minor, currency)
          values ('${paymentId}', 'paddle', 'adj_old_code', 'api', 'pending', 100, 'USD')
          on conflict (provider, provider_refund_id) do nothing
          returning id`;
        const insertKey = `
          insert into idempotency_keys (scope, key, request_hash, status, payment_id)
          values ('api:create_payment', 'old-code-key', '${REQUEST_HASH}', 'in_progress', '${paymentId}')
          on conflict (scope, key) do nothing
          returning key`;
        const insertEvent = `
          insert into webhook_events (provider, dedup_key, status, signature_valid, raw_body, next_attempt_at)
          values ('paddle', 'evt_old_code', 'received', true, '\\x7b7d', clock_timestamp())
          on conflict (provider, dedup_key) where replay_of is null do nothing
          returning id`;

        for (const statement of [insertRefund, insertKey, insertEvent]) {
          expect(await insertedCountOf(database, statement)).toBe(1);
          expect(await insertedCountOf(database, statement)).toBe(0);
        }
        expect(
          await rowsOf(
            database,
            `select
              (select project_id from payments where id = '${paymentId}') as payment_project,
              (select provider_account_id from payments where id = '${paymentId}') as payment_account,
              (select project_id from refunds where payment_id = '${paymentId}') as refund_project,
              (select project_id from idempotency_keys where key = 'old-code-key') as key_project,
              (select provider_account_id from webhook_events where dedup_key = 'evt_old_code') as event_account`,
          ),
        ).toEqual([
          {
            payment_project: SEED_PROJECT_ID,
            payment_account: null,
            refund_project: SEED_PROJECT_ID,
            key_project: SEED_PROJECT_ID,
            event_account: null,
          },
        ]);
      }),
    SLOW_TEST_TIMEOUT_MS,
  );

  describe('with a second project', () => {
    const secondProjectSql = `
      insert into provider_accounts (id, project_id, provider, credentials_ref)
      values ('${SEED_FAKE_ACCOUNT_ID}', '${SEED_PROJECT_ID}', 'fake', 'env:FAKE');
      insert into projects (id, slug, name) values ('${OTHER_PROJECT_ID}', 'project-b', 'Project B');
      insert into provider_accounts (id, project_id, provider, credentials_ref)
      values ('${OTHER_ACCOUNT_ID}', '${OTHER_PROJECT_ID}', 'fake', 'env:FAKE_B');
      insert into payments (id, project_id, provider_account_id, provider, provider_payment_id, purpose, origin, status, amount_minor, currency)
      values ('${FAKE_PAYMENT_ID}', '${SEED_PROJECT_ID}', '${SEED_FAKE_ACCOUNT_ID}', 'fake', 'fake_seed', 'one_off', 'api', 'succeeded', 2000, 'USD');
    `;

    const refundSql = (projectId: string, accountId: string): string => `
      insert into refunds (payment_id, project_id, provider_account_id, provider, provider_refund_id, origin, status, amount_minor, currency)
      values ('${FAKE_PAYMENT_ID}', '${projectId}', '${accountId}', 'fake', gen_random_uuid()::text, 'api', 'pending', 100, 'USD')`;

    const keySql = (projectId: string): string => `
      insert into idempotency_keys (project_id, scope, key, request_hash, status, payment_id)
      values ('${projectId}', 'api:create_refund', gen_random_uuid()::text, '${REQUEST_HASH}', 'in_progress', '${FAKE_PAYMENT_ID}')`;

    const paymentSql = (provider: string): string => `
      insert into payments (project_id, provider_account_id, provider, purpose, origin, status, amount_minor, currency)
      values ('${SEED_PROJECT_ID}', '${SEED_FAKE_ACCOUNT_ID}', '${provider}', 'one_off', 'api', 'created', 1000, 'USD')`;

    it(
      'refuses a payment whose provider is not its account provider',
      () =>
        withDatabase(async (database) => {
          await migrateToLatest(database);
          await database.exec(secondProjectSql);

          expect(await errorCodeOf(database, paymentSql('fake'))).toBeNull();
          expect(await errorCodeOf(database, paymentSql('paddle'))).toBe(
            FOREIGN_KEY_VIOLATION,
          );
        }),
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'refuses a refund whose project or account is not its payment one',
      () =>
        withDatabase(async (database) => {
          await migrateToLatest(database);
          await database.exec(secondProjectSql);

          expect(
            await errorCodeOf(
              database,
              refundSql(SEED_PROJECT_ID, SEED_FAKE_ACCOUNT_ID),
            ),
          ).toBeNull();
          expect(
            await errorCodeOf(
              database,
              refundSql(OTHER_PROJECT_ID, SEED_FAKE_ACCOUNT_ID),
            ),
          ).toBe(FOREIGN_KEY_VIOLATION);
          expect(
            await errorCodeOf(
              database,
              refundSql(SEED_PROJECT_ID, OTHER_ACCOUNT_ID),
            ),
          ).toBe(FOREIGN_KEY_VIOLATION);
        }),
      SLOW_TEST_TIMEOUT_MS,
    );

    it(
      'refuses an idempotency key that points at another project payment',
      () =>
        withDatabase(async (database) => {
          await migrateToLatest(database);
          await database.exec(secondProjectSql);

          expect(
            await errorCodeOf(database, keySql(SEED_PROJECT_ID)),
          ).toBeNull();
          expect(await errorCodeOf(database, keySql(OTHER_PROJECT_ID))).toBe(
            FOREIGN_KEY_VIOLATION,
          );
        }),
      SLOW_TEST_TIMEOUT_MS,
    );
  });
});
