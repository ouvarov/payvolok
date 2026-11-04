import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from '@/database/drizzle';

const READINESS_TIMEOUT_MS = 2000;

type Liveness = { status: 'ok' };
type Readiness = { status: 'ok' };

const rejectAfter = (timeoutMs: number) => {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

@Injectable()
export class HealthService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  getLiveness(): Liveness {
    return { status: 'ok' };
  }

  async getReadiness(): Promise<Readiness> {
    const timeout = rejectAfter(READINESS_TIMEOUT_MS);

    try {
      await Promise.race([this.db.execute(sql`select 1`), timeout.promise]);
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    } finally {
      timeout.cancel();
    }

    return { status: 'ok' };
  }
}
