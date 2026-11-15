import { createHash } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import {
  MAX_FAILURE_REASON_LENGTH,
  storableText,
} from '@/common/storable-text';
import { describeError } from '@/database/postgres-errors';
import {
  ProviderAccountsService,
  type AccountRef,
} from '@/provider-accounts/provider-accounts.service';
import type {
  PaymentProvider,
  WebhookRequest,
} from '@/providers/payment-provider.port';
import type { ProviderCode } from '@/providers/provider.constants';
import {
  dedupKeyFromBody,
  type ProviderEvents,
} from '@/providers/provider-events';
import { ProviderRegistry } from '@/providers/provider.registry';

import {
  INVALID_DEDUP_KEY_PREFIX,
  storableDedupKey,
} from './webhook-dedup-key';
import { storableHeaders } from './webhook-headers';
import { WebhookWorker } from './webhook.worker';
import { WebhooksRepository } from './webhooks.repository';

const MAX_INVALID_ROWS_PER_WINDOW = 20;
const webhookEventIdSchema = z.uuid();
const INVALID_ROWS_WINDOW_MS = 60 * 60 * 1000;

type InvalidAttemptWindow = { startedAtEpochMs: number; attempts: number };

const firstFailureReasonOf = (events: ProviderEvents): string | null => {
  for (const event of events) {
    if ('failureReason' in event && event.failureReason !== null) {
      return storableText(event.failureReason, MAX_FAILURE_REASON_LENGTH);
    }
  }

  return null;
};

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly invalidAttemptWindows = new Map<
    ProviderCode,
    InvalidAttemptWindow
  >();

  constructor(
    private readonly providerAccountsService: ProviderAccountsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly webhooksRepository: WebhooksRepository,
    private readonly webhookWorker: WebhookWorker,
  ) {}

  async replay(webhookEventId: string): Promise<string | null> {
    if (!webhookEventIdSchema.safeParse(webhookEventId).success) return null;

    const replayId = await this.webhooksRepository.insertReplay(webhookEventId);
    if (replayId) this.webhookWorker.kick();

    return replayId;
  }

  async receive(
    providerCode: string,
    body: unknown,
    headers: WebhookRequest['headers'],
  ): Promise<void> {
    const provider = this.providerRegistry.find(providerCode);
    if (!provider) throw new NotFoundException();
    const account = await this.seedAccountOf(provider.code);
    if (!account) throw new NotFoundException();

    const request: WebhookRequest = {
      rawBody: Buffer.isBuffer(body) ? body : Buffer.alloc(0),
      headers,
    };

    if (!(await this.isSignatureValid(provider, request))) {
      await this.storeInvalidDelivery(
        provider.code,
        account.id,
        request.rawBody,
      );
      throw new UnauthorizedException();
    }

    await this.storeDelivery(provider, account.id, request);
  }

  private async seedAccountOf(
    provider: ProviderCode,
  ): Promise<AccountRef | null> {
    try {
      return await this.providerAccountsService.seedAccountOf(provider);
    } catch (error) {
      this.logger.error(
        `Webhook account lookup failed for ${provider}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }
  }

  private async isSignatureValid(
    provider: PaymentProvider,
    request: WebhookRequest,
  ): Promise<boolean> {
    try {
      return await provider.verifyWebhook(request);
    } catch (error) {
      this.logger.warn(
        `Webhook verification unavailable for ${provider.code}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }
  }

  private async storeInvalidDelivery(
    provider: ProviderCode,
    providerAccountId: string,
    rawBody: Buffer,
  ): Promise<void> {
    const attempts = this.countInvalidAttempt(provider);
    if (attempts > MAX_INVALID_ROWS_PER_WINDOW) {
      if (attempts === MAX_INVALID_ROWS_PER_WINDOW + 1) {
        this.logger.warn(
          `Webhooks with an invalid signature for ${provider} reached the row cap for this hour`,
        );
      }
      return;
    }

    const bodyHash = createHash('sha256').update(rawBody).digest('hex');

    try {
      await this.webhooksRepository.insertInvalidIfAbsent({
        provider,
        providerAccountId,
        dedupKey: `${INVALID_DEDUP_KEY_PREFIX}${bodyHash}`,
      });
    } catch (error) {
      this.logger.error(
        `Webhook invalid-signature row failed for ${provider}: ${describeError(error)}`,
      );
    }
  }

  private countInvalidAttempt(provider: ProviderCode): number {
    const nowEpochMs = Date.now();
    const window = this.invalidAttemptWindows.get(provider);

    if (
      !window ||
      nowEpochMs - window.startedAtEpochMs >= INVALID_ROWS_WINDOW_MS
    ) {
      this.invalidAttemptWindows.set(provider, {
        startedAtEpochMs: nowEpochMs,
        attempts: 1,
      });
      return 1;
    }

    window.attempts += 1;
    return window.attempts;
  }

  private async storeDelivery(
    provider: PaymentProvider,
    providerAccountId: string,
    request: WebhookRequest,
  ): Promise<void> {
    const events = this.parseOrNull(provider, request);
    let isInserted: boolean;

    try {
      isInserted = await this.webhooksRepository.insertReceivedIfAbsent({
        provider: provider.code,
        providerAccountId,
        dedupKey: events
          ? storableDedupKey(events[0].dedupKey)
          : dedupKeyFromBody(request.rawBody),
        rawBody: request.rawBody,
        headers: storableHeaders(request.headers, provider.webhookHeaders),
        eventTypes: events ? events.map(({ type }) => type) : [],
        failureReason: events ? firstFailureReasonOf(events) : null,
      });
    } catch (error) {
      this.logger.error(
        `Webhook insert failed for ${provider.code}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }

    if (isInserted) this.webhookWorker.kick();
  }

  private parseOrNull(
    provider: PaymentProvider,
    request: WebhookRequest,
  ): ProviderEvents | null {
    try {
      return provider.parseWebhook(request);
    } catch (error) {
      this.logger.warn(
        `Webhook parse failed for ${provider.code}: ${describeError(error)}`,
      );
      return null;
    }
  }
}
