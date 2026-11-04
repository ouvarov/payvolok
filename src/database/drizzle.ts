import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

const DRIZZLE = Symbol('DRIZZLE');

type Database = PostgresJsDatabase;

export { DRIZZLE };
export type { Database };
