import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';

import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  webhookEvents,
  type NewWebhookEvent,
  type WebhookEvent,
} from '@/database/schemas/webhook-events.schema';

// The 10 s statement_timeout bounds each statement, not a delivery that runs one transaction per event.
const LEASE_SECONDS = 300;

type ReceivedDelivery = Pick<
  NewWebhookEvent,
  | 'provider'
  | 'providerAccountId'
  | 'dedupKey'
  | 'rawBody'
  | 'headers'
  | 'eventTypes'
  | 'failureReason'
>;

type InvalidDelivery = Pick<
  NewWebhookEvent,
  'provider' | 'providerAccountId' | 'dedupKey'
>;

type ClaimedWebhookEvent = {
  id: string;
  provider: string;
  providerAccountId: string | null;
  replayOf: string | null;
  attempts: number;
};

type StoredDelivery = {
  rawBody: Buffer;
  headers: WebhookEvent['headers'];
};

type WebhookEventFinish =
  | {
      status: 'received';
      retryDelaySeconds: number;
      lastError: string;
      paymentIds: string[];
    }
  | {
      status: 'processed' | 'ignored' | 'failed';
      lastError: string | null;
      paymentIds: string[];
    };

type ClaimedRow = {
  id: string;
  provider: string;
  provider_account_id: string | null;
  replay_of: string | null;
  attempts: number;
};

@Injectable()
export class WebhooksRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  insertReceivedIfAbsent(delivery: ReceivedDelivery): Promise<boolean> {
    return this.insertIfAbsent({
      ...delivery,
      status: 'received',
      signatureValid: true,
      nextAttemptAt: sql`clock_timestamp()`,
    });
  }

  async insertInvalidIfAbsent(delivery: InvalidDelivery): Promise<void> {
    await this.insertIfAbsent({
      ...delivery,
      status: 'ignored',
      signatureValid: false,
      finishedAt: sql`clock_timestamp()`,
    });
  }

  // One autocommit statement, so processing holds no transaction. The WHERE
  // reads now(): the volatile clock_timestamp() cannot be an index qual.
  async claimNext(): Promise<ClaimedWebhookEvent | null> {
    const [row] = await this.db.execute<ClaimedRow>(sql`
      UPDATE webhook_events
      SET attempts = attempts + 1,
          next_attempt_at = clock_timestamp() + ${LEASE_SECONDS}::integer * interval '1 second'
      WHERE id = (
        SELECT id FROM webhook_events
        WHERE status = 'received' AND next_attempt_at <= now()
        ORDER BY next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, provider, provider_account_id, replay_of, attempts
    `);
    if (!row) return null;

    return {
      id: row.id,
      provider: row.provider,
      providerAccountId: row.provider_account_id,
      replayOf: row.replay_of,
      attempts: row.attempts,
    };
  }

  async findDelivery(id: string): Promise<StoredDelivery | null> {
    const [row] = await this.db
      .select({
        rawBody: webhookEvents.rawBody,
        headers: webhookEvents.headers,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, id));
    if (!row?.rawBody) return null;

    return { rawBody: row.rawBody, headers: row.headers };
  }

  // Fenced by attempts: a worker whose lease expired and was reclaimed changes nothing.
  async finish(
    claimed: ClaimedWebhookEvent,
    finish: WebhookEventFinish,
  ): Promise<boolean> {
    const isRetry = finish.status === 'received';
    const finishedRows = await this.db
      .update(webhookEvents)
      .set({
        status: finish.status,
        lastError: finish.lastError,
        paymentIds: finish.paymentIds,
        nextAttemptAt: isRetry
          ? sql`clock_timestamp() + ${finish.retryDelaySeconds}::integer * interval '1 second'`
          : null,
        finishedAt: isRetry ? null : sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(webhookEvents.id, claimed.id),
          eq(webhookEvents.attempts, claimed.attempts),
          eq(webhookEvents.status, 'received'),
        ),
      )
      .returning({ id: webhookEvents.id });

    return finishedRows.length > 0;
  }

  // Replays always point at the root, which holds the body and the headers.
  async insertReplay(originalId: string): Promise<string | null> {
    const [row] = await this.db.execute<{ id: string }>(sql`
      INSERT INTO webhook_events
        (provider, provider_account_id, dedup_key, status, signature_valid, replay_of, next_attempt_at)
      SELECT provider, provider_account_id, dedup_key, 'received', true, coalesce(replay_of, id), clock_timestamp()
      FROM webhook_events
      WHERE id = ${originalId} AND signature_valid
      RETURNING id
    `);

    return row?.id ?? null;
  }

  private async insertIfAbsent(
    newEvent: PgInsertValue<typeof webhookEvents>,
  ): Promise<boolean> {
    const insertedRows = await this.db
      .insert(webhookEvents)
      .values(newEvent)
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.dedupKey],
        where: sql`${webhookEvents.replayOf} IS NULL`,
      })
      .returning({ id: webhookEvents.id });

    return insertedRows.length > 0;
  }
}

export type { ClaimedWebhookEvent, StoredDelivery, WebhookEventFinish };
