import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from './drizzle';

@Injectable()
export class DatabaseService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}
