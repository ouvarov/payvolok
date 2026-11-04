import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

const DRIZZLE = Symbol('DRIZZLE');

type Database = PostgresJsDatabase;
type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

export { DRIZZLE };
export type { Database, DatabaseTransaction };
