import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { DatabaseService } from '@/database/database.service';

const READINESS_TIMEOUT_MS = 2000;

type HealthStatus = { status: 'ok' };

const rejectAfter = (timeoutMs: number) => {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

const describeFailure = (error: unknown): string => {
  const root =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
  if (!(root instanceof Error)) return String(root);
  return root.message || ('code' in root ? String(root.code) : root.name);
};

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DatabaseService)
    private readonly database: Pick<DatabaseService, 'ping'>,
  ) {}

  getLiveness(): HealthStatus {
    return { status: 'ok' };
  }

  async getReadiness(): Promise<HealthStatus> {
    const timeout = rejectAfter(READINESS_TIMEOUT_MS);

    try {
      await Promise.race([this.database.ping(), timeout.promise]);
    } catch (error) {
      this.logger.warn(`Readiness check failed: ${describeFailure(error)}`);
      throw new ServiceUnavailableException({ status: 'unavailable' });
    } finally {
      timeout.cancel();
    }

    return { status: 'ok' };
  }
}

export type { HealthStatus };
