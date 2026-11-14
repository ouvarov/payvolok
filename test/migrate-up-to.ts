import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { MIGRATIONS_FOLDER } from './apply-migrations';

type Journal = { entries: { tag: string }[] };

// The migrator applies every journal entry, so an older schema needs a folder whose journal stops there.
const migrateUpTo = async (
  database: PGlite,
  migrationNumber: string,
): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), `payvolok-${migrationNumber}-`));

  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    const lastIndex = journal.entries.findIndex(({ tag }) =>
      tag.startsWith(`${migrationNumber}_`),
    );
    if (lastIndex === -1) {
      throw new Error(`Migration ${migrationNumber} is missing`);
    }

    writeFileSync(
      journalPath,
      JSON.stringify({
        ...journal,
        entries: journal.entries.slice(0, lastIndex + 1),
      }),
    );
    await migrate(drizzle(database), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const migrateToLatest = (database: PGlite): Promise<void> =>
  migrate(drizzle(database), { migrationsFolder: MIGRATIONS_FOLDER });

export { migrateToLatest, migrateUpTo };
