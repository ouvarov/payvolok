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

import { WebhookEventProcessor } from './webhook-event.processor';
import { WebhooksRepository } from './webhooks.repository';

const WORKER_STOP_TIMEOUT_MS = 15000;

@Injectable()
export class WebhookWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WebhookWorker.name);
  private readonly isEnabled: boolean;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;
  private isKickPending = false;
  private isStopped = false;
  private isFailing = false;

  constructor(
    configService: ConfigService<Env, true>,
    private readonly webhooksRepository: WebhooksRepository,
    private readonly webhookEventProcessor: WebhookEventProcessor,
  ) {
    this.isEnabled = configService.get('WEBHOOK_WORKER_ENABLED', {
      infer: true,
    });
    this.pollIntervalMs = configService.get('WEBHOOK_POLL_INTERVAL_MS', {
      infer: true,
    });
  }

  onApplicationBootstrap(): void {
    if (this.isEnabled) this.schedule(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isStopped = true;
    this.clearTimer();
    if (!this.cycle) return;

    const isFinished = await waitAtMost(this.cycle, WORKER_STOP_TIMEOUT_MS);
    if (!isFinished) {
      this.logger.warn('Webhook worker stopped with a row still in flight');
    }
  }

  kick(): void {
    if (!this.isEnabled || this.isStopped) return;
    if (this.cycle) {
      this.isKickPending = true;
      return;
    }

    this.clearTimer();
    this.startCycle();
  }

  async drain(): Promise<number> {
    let processedCount = 0;
    while (await this.processNext()) processedCount += 1;

    return processedCount;
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
      if (this.isStopped) return;
      if (!this.isKickPending) {
        this.schedule(this.pollIntervalMs);
        return;
      }

      this.isKickPending = false;
      this.startCycle();
    });
  }

  private async runCycle(): Promise<void> {
    try {
      let hasClaimedRow = true;
      while (hasClaimedRow && !this.isStopped) {
        hasClaimedRow = await this.processNext();
      }
      this.reportRecovery();
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async processNext(): Promise<boolean> {
    const claimed = await this.webhooksRepository.claimNext();
    if (!claimed) return false;

    const delivery = await this.webhooksRepository.findDelivery(
      claimed.replayOf ?? claimed.id,
    );
    const finish = await this.webhookEventProcessor.process(claimed, delivery);
    await this.webhooksRepository.finish(claimed, finish);

    return true;
  }

  private reportFailure(error: unknown): void {
    if (this.isFailing) return;

    this.isFailing = true;
    this.logger.warn(`Webhook worker cycle failed: ${describeError(error)}`);
  }

  private reportRecovery(): void {
    if (!this.isFailing) return;

    this.isFailing = false;
    this.logger.log('Webhook worker recovered');
  }
}

export { WORKER_STOP_TIMEOUT_MS };
