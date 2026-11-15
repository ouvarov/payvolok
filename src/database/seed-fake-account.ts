import { parseArgs } from 'node:util';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { envSchema } from '../config/env.schema';
import { SEED_PROJECT_ID } from '../projects/projects.constants';
import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_FAKE_CREDENTIALS_REF,
} from '../provider-accounts/provider-accounts.constants';

type SeedTarget = {
  databaseUrl: string;
  nodeEnv: string;
  targetHost: string | null;
};

const hostOf = (databaseUrl: string): string =>
  new URL(databaseUrl).hostname.toLowerCase();

// NODE_ENV defaults to development, so a .env pointed at production would pass
// on it alone; the operator has to name the host the row goes to.
const assertSeedTarget = ({
  databaseUrl,
  nodeEnv,
  targetHost,
}: SeedTarget): void => {
  if (nodeEnv === 'production') {
    throw new Error('The fake provider account is never seeded in production');
  }

  const databaseHost = hostOf(databaseUrl);
  if (targetHost === null) {
    throw new Error(
      `DATABASE_URL points at ${databaseHost}; pass --target-host ${databaseHost} to seed it`,
    );
  }
  if (targetHost.toLowerCase() !== databaseHost) {
    throw new Error(
      `--target-host ${targetHost} does not match the DATABASE_URL host ${databaseHost}`,
    );
  }
};

const seedFakeAccount = async (target: SeedTarget): Promise<void> => {
  assertSeedTarget(target);

  const client = postgres(target.databaseUrl, {
    max: 1,
    onnotice: () => {},
  });

  try {
    await drizzle(client).execute(sql`
      INSERT INTO provider_accounts (id, project_id, provider, credentials_ref)
      VALUES (${SEED_FAKE_ACCOUNT_ID}::uuid, ${SEED_PROJECT_ID}::uuid, 'fake', ${SEED_FAKE_CREDENTIALS_REF})
      ON CONFLICT DO NOTHING
    `);
  } finally {
    await client.end();
  }
};

const runSeed = async (): Promise<void> => {
  const { DATABASE_URL, NODE_ENV } = envSchema
    .pick({ DATABASE_URL: true, NODE_ENV: true })
    .parse(process.env);
  const { values } = parseArgs({
    options: { 'target-host': { type: 'string' } },
  });

  console.log(`Seeding the fake provider account on ${hostOf(DATABASE_URL)}`);
  await seedFakeAccount({
    databaseUrl: DATABASE_URL,
    nodeEnv: NODE_ENV,
    targetHost: values['target-host'] ?? null,
  });
  console.log('Fake provider account seeded');
};

if (require.main === module) {
  runSeed().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { assertSeedTarget, seedFakeAccount };
