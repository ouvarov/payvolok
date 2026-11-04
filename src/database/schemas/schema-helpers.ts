import { sql, type SQL } from 'drizzle-orm';

const quotedList = (values: readonly string[]): SQL =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

export { quotedList };
