import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  apiKeyHashOf,
  apiKeyPrefixOf,
  API_KEY_PATTERN,
} from '../src/projects/api-key';
import { SEED_PROJECT_ID } from '../src/projects/projects.constants';

const TEST_API_KEY = `pv_test_${'e2e-seed-project-key'.padEnd(43, '0')}`;
const SEED_RETURN_ORIGINS = [
  'https://shop.example.test',
  'https://example.test',
];

// Global setup runs outside Jest's module mapper, so this file imports no @/ path.
const seedTestApiKey = async (databaseUrl: string): Promise<void> => {
  if (!API_KEY_PATTERN.test(TEST_API_KEY)) {
    throw new Error('TEST_API_KEY does not match API_KEY_PATTERN');
  }

  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    const db = drizzle(client);
    await db.execute(sql`
      INSERT INTO api_keys (project_id, name, key_hash, key_prefix)
      VALUES (${SEED_PROJECT_ID}::uuid, 'e2e', ${apiKeyHashOf(TEST_API_KEY)}, ${apiKeyPrefixOf(TEST_API_KEY)})
      ON CONFLICT (key_hash) DO NOTHING
    `);
    await db.execute(sql`
      UPDATE projects
      SET allowed_return_origins = ${`{${SEED_RETURN_ORIGINS.join(',')}}`}::text[]
      WHERE id = ${SEED_PROJECT_ID}::uuid
    `);
  } finally {
    await client.end();
  }
};

export { seedTestApiKey, SEED_RETURN_ORIGINS, TEST_API_KEY };
