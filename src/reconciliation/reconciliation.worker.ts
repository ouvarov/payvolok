import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { waitAtMost } from '@/common/wait-at-most';
import type { Env } from '@/config/env.schema';
import { describeError } from '@/database/postgres-errors';
import { IdempotencyService } from '@/idempotency/idempotency.service';

import {
  IDEMPOTENCY_PURGE_BATCH_SIZE,
  IDEMPOTENCY_PURGE_INTERVAL_MS,
  IDEMPOTENCY_PURGE_MAX_BATCHES,
  RECONCILE_BATCH_SIZE,
  RECONCILIATION_STOP_TIMEOUT_MS,
} from './reconciliation.constants';
import {
  ReconciliationRepository,
  type ReconciliationScopeKey,
} from './reconciliation.repository';
import {
  ReconciliationService,
  type ReconcileResult,
} from './reconciliation.service';

type BatchSummary = { checkedCount: number; changedCount: number };

@Injectable()
export class ReconciliationWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ReconciliationWorker.name);
  private readonly isEnabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly failingScopeKeys = new Set<ReconciliationScopeKey>();
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;
  private lastPurgeAtEpochMs: number | null = null;
  private isStopped = false;
  private isFailing = false;

  constructor(
    configService: ConfigService<Env, true>,
    private readonly reconciliationRepository: ReconciliationRepository,
    private readonly reconciliationService: ReconciliationService,
    private readonly idempotencyService: IdempotencyService,
  ) {
    this.isEnabled = configService.get('RECONCILIATION_WORKER_ENABLED', {
      infer: true,
    });
    this.pollIntervalMs = configService.get('RECONCILIATION_POLL_INTERVAL_MS', {
      infer: true,
    });
  }

  // On a host that sleeps when idle, boot is the wake, so the first cycle runs at once.
  onApplicationBootstrap(): void {
    if (this.isEnabled) this.schedule(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isStopped = true;
    this.clearTimer();
    if (!this.cycle) return;

    const isFinished = await waitAtMost(
      this.cycle,
      RECONCILIATION_STOP_TIMEOUT_MS,
    );
    if (!isFinished) {
      this.logger.warn('Reconciliation stopped with a check still in flight');
    }
  }

  async drain(): Promise<number> {
    const { checkedCount, changedCount } = await this.reconcileBatch();
    if (changedCount > 0) {
      this.logger.log(
        `Reconciliation checked ${checkedCount} payments, changed ${changedCount}`,
      );
    }

    return checkedCount;
  }

  async purge(): Promise<number> {
    let purgedCount = 0;
    for (let batch = 0; batch < IDEMPOTENCY_PURGE_MAX_BATCHES; batch += 1) {
      const batchCount = await this.idempotencyService.purgeExpired(
        IDEMPOTENCY_PURGE_BATCH_SIZE,
      );
      purgedCount += batchCount;
      if (batchCount < IDEMPOTENCY_PURGE_BATCH_SIZE) break;
    }
    if (purgedCount > 0) {
      this.logger.log(`Purged ${purgedCount} expired idempotency keys`);
    }

    return purgedCount;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startCycle();
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private startCycle(): void {
    this.cycle = this.runCycle().finally(() => {
      this.cycle = null;
      if (!this.isStopped) this.schedule(this.pollIntervalMs);
    });
  }

  private async runCycle(): Promise<void> {
    try {
      await this.drain();
      await this.purgeIfDue();
      this.reportRecovery();
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async reconcileBatch(): Promise<BatchSummary> {
    const skippedScopeKeys = new Set<ReconciliationScopeKey>();
    const summary: BatchSummary = { checkedCount: 0, changedCount: 0 };

    while (summary.checkedCount < RECONCILE_BATCH_SIZE && !this.isStopped) {
      const claimed = await this.reconciliationRepository.claimNext([
        ...skippedScopeKeys,
      ]);
      if (!claimed) break;

      const result = await this.reconciliationService.reconcile(claimed);
      summary.checkedCount += 1;
      if (result.outcome === 'provider_failed') {
        skippedScopeKeys.add(result.scopeKey);
      } else if (result.isChanged) {
        summary.changedCount += 1;
      }
      this.reportProviderHealth(result);
    }

    return summary;
  }

  private async purgeIfDue(): Promise<void> {
    if (this.isStopped) return;

    const nowEpochMs = Date.now();
    if (
      this.lastPurgeAtEpochMs !== null &&
      nowEpochMs - this.lastPurgeAtEpochMs < IDEMPOTENCY_PURGE_INTERVAL_MS
    ) {
      return;
    }

    await this.purge();
    this.lastPurgeAtEpochMs = nowEpochMs;
  }

  private reportProviderHealth(result: ReconcileResult): void {
    if (result.outcome === 'local') return;
    if (result.outcome === 'checked') {
      if (this.failingScopeKeys.delete(result.scopeKey)) {
        this.logger.log(`Reconciliation reaches ${result.scopeKey} again`);
      }
      return;
    }
    if (this.failingScopeKeys.has(result.scopeKey)) return;

    this.failingScopeKeys.add(result.scopeKey);
    const { kind, detail } = result.failure;
    const message = `Reconciliation skips ${result.scopeKey} until it answers: provider_${kind}: ${detail}`;
    if (kind === 'misconfigured') {
      this.logger.error(message);
      return;
    }

    this.logger.warn(message);
  }

  private reportFailure(error: unknown): void {
    if (this.isFailing) return;

    this.isFailing = true;
    this.logger.warn(`Reconciliation cycle failed: ${describeError(error)}`);
  }

  private reportRecovery(): void {
    if (!this.isFailing) return;

    this.isFailing = false;
    this.logger.log('Reconciliation recovered');
  }
}
