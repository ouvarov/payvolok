import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';

import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  webhookEvents,
  type NewWebhookEvent,
} from '@/database/schemas/webhook-events.schema';
import type { ProviderCode } from '@/providers/provider.constants';

type ReceivedDelivery = Pick<
  NewWebhookEvent,
  | 'provider'
  | 'dedupKey'
  | 'rawBody'
  | 'headers'
  | 'eventTypes'
  | 'failureReason'
>;

@Injectable()
export class WebhooksRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  insertReceivedIfAbsent(delivery: ReceivedDelivery): Promise<void> {
    return this.insertIfAbsent({
      ...delivery,
      status: 'received',
      signatureValid: true,
      nextAttemptAt: sql`clock_timestamp()`,
    });
  }

  insertInvalidIfAbsent(
    provider: ProviderCode,
    dedupKey: string,
  ): Promise<void> {
    return this.insertIfAbsent({
      provider,
      dedupKey,
      status: 'ignored',
      signatureValid: false,
      finishedAt: sql`clock_timestamp()`,
    });
  }

  private async insertIfAbsent(
    newEvent: PgInsertValue<typeof webhookEvents>,
  ): Promise<void> {
    await this.db
      .insert(webhookEvents)
      .values(newEvent)
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.dedupKey],
        where: sql`${webhookEvents.replayOf} IS NULL`,
      });
  }
}
