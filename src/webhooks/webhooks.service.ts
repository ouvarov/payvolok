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
import { SEED_PADDLE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';
import { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import type {
  BoundProvider,
  WebhookRequest,
} from '@/providers/payment-provider.port';
import {
  isProviderCode,
  type ProviderCode,
} from '@/providers/provider.constants';
import {
  dedupKeyFromBody,
  type ProviderEvents,
} from '@/providers/provider-events';

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
const ALIAS_WARN_INTERVAL_MS = 60 * 60 * 1000;

type InvalidAttemptWindow = { startedAtEpochMs: number; attempts: number };

const labelOf = (provider: BoundProvider): string =>
  `${provider.code} account ${provider.accountId}`;

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
  // Keyed by account id; only accounts that exist get here, so the map stays small.
  private readonly invalidAttemptWindows = new Map<
    string,
    InvalidAttemptWindow
  >();
  private lastAliasWarnAtEpochMs: number | null = null;

  constructor(
    private readonly providerAccountsService: ProviderAccountsService,
    private readonly webhooksRepository: WebhooksRepository,
    private readonly webhookWorker: WebhookWorker,
  ) {}

  async replay(webhookEventId: string): Promise<string | null> {
    if (!webhookEventIdSchema.safeParse(webhookEventId).success) return null;

    const replayId = await this.webhooksRepository.insertReplay(webhookEventId);
    if (replayId) this.webhookWorker.kick();

    return replayId;
  }

  // The URL Paddle was given before accounts existed, kept until Paddle is switched.
  receiveOnPaddleAlias(
    body: unknown,
    headers: WebhookRequest['headers'],
  ): Promise<void> {
    this.warnAboutAliasHourly();

    return this.receive('paddle', SEED_PADDLE_ACCOUNT_ID, body, headers);
  }

  async receive(
    providerCode: string,
    providerAccountId: string,
    body: unknown,
    headers: WebhookRequest['headers'],
  ): Promise<void> {
    if (!isProviderCode(providerCode)) throw new NotFoundException();
    const provider = await this.boundProviderFor(
      providerCode,
      providerAccountId,
    );
    if (!provider) throw new NotFoundException();

    const request: WebhookRequest = {
      rawBody: Buffer.isBuffer(body) ? body : Buffer.alloc(0),
      headers,
    };

    if (!(await this.isSignatureValid(provider, request))) {
      await this.storeInvalidDelivery(provider, request.rawBody);
      throw new UnauthorizedException();
    }

    await this.storeDelivery(provider, request);
  }

  private warnAboutAliasHourly(): void {
    const nowEpochMs = Date.now();
    if (
      this.lastAliasWarnAtEpochMs !== null &&
      nowEpochMs - this.lastAliasWarnAtEpochMs < ALIAS_WARN_INTERVAL_MS
    ) {
      return;
    }

    this.lastAliasWarnAtEpochMs = nowEpochMs;
    this.logger.warn(
      `Webhook received on /webhooks/paddle; point Paddle at /webhooks/paddle/${SEED_PADDLE_ACCOUNT_ID}`,
    );
  }

  private async boundProviderFor(
    providerCode: ProviderCode,
    providerAccountId: string,
  ): Promise<BoundProvider | null> {
    try {
      return await this.providerAccountsService.bindForWebhook(
        providerCode,
        providerAccountId,
      );
    } catch (error) {
      this.logger.error(
        `Webhook account lookup failed for ${providerCode}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }
  }

  private async isSignatureValid(
    provider: BoundProvider,
    request: WebhookRequest,
  ): Promise<boolean> {
    try {
      return await provider.verifyWebhook(request);
    } catch (error) {
      this.logger.warn(
        `Webhook verification unavailable for ${labelOf(provider)}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }
  }

  private async storeInvalidDelivery(
    provider: BoundProvider,
    rawBody: Buffer,
  ): Promise<void> {
    const attempts = this.countInvalidAttempt(provider.accountId);
    if (attempts > MAX_INVALID_ROWS_PER_WINDOW) {
      if (attempts === MAX_INVALID_ROWS_PER_WINDOW + 1) {
        this.logger.warn(
          `Webhooks with an invalid signature for ${labelOf(provider)} reached the row cap for this hour`,
        );
      }
      return;
    }

    const bodyHash = createHash('sha256').update(rawBody).digest('hex');

    try {
      await this.webhooksRepository.insertInvalidIfAbsent({
        provider: provider.code,
        providerAccountId: provider.accountId,
        dedupKey: `${INVALID_DEDUP_KEY_PREFIX}${bodyHash}`,
      });
    } catch (error) {
      this.logger.error(
        `Webhook invalid-signature row failed for ${labelOf(provider)}: ${describeError(error)}`,
      );
    }
  }

  private countInvalidAttempt(providerAccountId: string): number {
    const nowEpochMs = Date.now();
    const window = this.invalidAttemptWindows.get(providerAccountId);

    if (
      !window ||
      nowEpochMs - window.startedAtEpochMs >= INVALID_ROWS_WINDOW_MS
    ) {
      this.invalidAttemptWindows.set(providerAccountId, {
        startedAtEpochMs: nowEpochMs,
        attempts: 1,
      });
      return 1;
    }

    window.attempts += 1;
    return window.attempts;
  }

  private async storeDelivery(
    provider: BoundProvider,
    request: WebhookRequest,
  ): Promise<void> {
    const events = this.parseOrNull(provider, request);
    let isInserted: boolean;

    try {
      isInserted = await this.webhooksRepository.insertReceivedIfAbsent({
        provider: provider.code,
        providerAccountId: provider.accountId,
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
        `Webhook insert failed for ${labelOf(provider)}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }

    if (isInserted) this.webhookWorker.kick();
  }

  private parseOrNull(
    provider: BoundProvider,
    request: WebhookRequest,
  ): ProviderEvents | null {
    try {
      return provider.parseWebhook(request);
    } catch (error) {
      this.logger.warn(
        `Webhook parse failed for ${labelOf(provider)}: ${describeError(error)}`,
      );
      return null;
    }
  }
}
