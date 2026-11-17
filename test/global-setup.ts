import './setup-env';

import { seedFakeAccount } from '../src/database/seed-fake-account';

import { applyMigrations } from './apply-migrations';
import { seedTestApiKey } from './test-api-key';

export default async (): Promise<void> => {
  const databaseUrl = process.env.E2E_DATABASE_URL as string;

  await applyMigrations(databaseUrl);
  await seedFakeAccount({
    databaseUrl,
    nodeEnv: 'test',
    targetHost: new URL(databaseUrl).hostname,
  });
  await seedTestApiKey(databaseUrl);
};
