import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const MIGRATIONS_FOLDER = join(__dirname, '..', 'drizzle');

const applyMigrations = async (databaseUrl: string): Promise<void> => {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
};

export { applyMigrations, MIGRATIONS_FOLDER };
