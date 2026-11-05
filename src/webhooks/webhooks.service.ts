import { createHash } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { postgresCodeOf } from '@/database/postgres-errors';
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
  storableDedupKey,
  storableHeaders,
  withoutControlCharacters,
} from './webhook-headers';
import { WebhooksRepository } from './webhooks.repository';

const MAX_INVALID_ROWS_PER_WINDOW = 20;
const INVALID_ROWS_WINDOW_MS = 60 * 60 * 1000;
const MAX_FAILURE_REASON_LENGTH = 200;

type InvalidRowsWindow = { startedAtEpochMs: number; count: number };

// Only the class and the pg code: a DrizzleQueryError message carries the query params.
const describeError = (error: unknown): string => {
  const errorClass =
    error instanceof Error ? error.constructor.name : 'unknown';
  const code = postgresCodeOf(error);

  return code ? `${errorClass} ${code}` : errorClass;
};

const firstFailureReasonOf = (events: ProviderEvents): string | null => {
  for (const event of events) {
    if ('failureReason' in event && event.failureReason !== null) {
      return withoutControlCharacters(event.failureReason).slice(
        0,
        MAX_FAILURE_REASON_LENGTH,
      );
    }
  }

  return null;
};

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly invalidRowsWindows = new Map<
    ProviderCode,
    InvalidRowsWindow
  >();

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly webhooksRepository: WebhooksRepository,
  ) {}

  async receive(
    providerCode: string,
    body: unknown,
    headers: WebhookRequest['headers'],
  ): Promise<void> {
    const provider = this.providerRegistry.find(providerCode);
    if (!provider) throw new NotFoundException();

    const request: WebhookRequest = {
      rawBody: Buffer.isBuffer(body) ? body : Buffer.alloc(0),
      headers,
    };

    if (!(await this.isSignatureValid(provider, request))) {
      await this.storeInvalidDelivery(provider.code, request.rawBody);
      throw new UnauthorizedException();
    }

    await this.storeDelivery(provider, request);
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
    rawBody: Buffer,
  ): Promise<void> {
    if (!this.takeInvalidRowSlot(provider)) {
      this.logger.warn(
        `Webhook with an invalid signature for ${provider}, row cap reached`,
      );
      return;
    }

    const bodyHash = createHash('sha256').update(rawBody).digest('hex');

    try {
      await this.webhooksRepository.insertInvalidIfAbsent(
        provider,
        `invalid:${bodyHash}`,
      );
    } catch (error) {
      this.logger.error(
        `Webhook invalid-signature row failed for ${provider}: ${describeError(error)}`,
      );
    }
  }

  private takeInvalidRowSlot(provider: ProviderCode): boolean {
    const nowEpochMs = Date.now();
    const window = this.invalidRowsWindows.get(provider);

    if (
      !window ||
      nowEpochMs - window.startedAtEpochMs >= INVALID_ROWS_WINDOW_MS
    ) {
      this.invalidRowsWindows.set(provider, {
        startedAtEpochMs: nowEpochMs,
        count: 1,
      });
      return true;
    }
    if (window.count >= MAX_INVALID_ROWS_PER_WINDOW) return false;

    window.count += 1;
    return true;
  }

  private async storeDelivery(
    provider: PaymentProvider,
    request: WebhookRequest,
  ): Promise<void> {
    const events = this.parseOrNull(provider, request);

    try {
      await this.webhooksRepository.insertReceivedIfAbsent({
        provider: provider.code,
        dedupKey: events
          ? storableDedupKey(events[0].dedupKey)
          : dedupKeyFromBody(request.rawBody),
        rawBody: request.rawBody,
        headers: storableHeaders(request.headers),
        eventTypes: events ? events.map(({ type }) => type) : [],
        failureReason: events ? firstFailureReasonOf(events) : null,
      });
    } catch (error) {
      this.logger.error(
        `Webhook insert failed for ${provider.code}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }
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
