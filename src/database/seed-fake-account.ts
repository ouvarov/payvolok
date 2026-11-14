import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { envSchema } from '../config/env.schema';
import { SEED_PROJECT_ID } from '../projects/projects.constants';
import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_FAKE_CREDENTIALS_REF,
} from '../provider-accounts/provider-accounts.constants';

type SeedTarget = { databaseUrl: string; nodeEnv: string };

const seedFakeAccount = async ({
  databaseUrl,
  nodeEnv,
}: SeedTarget): Promise<void> => {
  if (nodeEnv === 'production') {
    throw new Error('The fake provider account is never seeded in production');
  }

  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

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

  await seedFakeAccount({ databaseUrl: DATABASE_URL, nodeEnv: NODE_ENV });
  console.log('Fake provider account seeded');
};

if (require.main === module) {
  runSeed().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { seedFakeAccount };
