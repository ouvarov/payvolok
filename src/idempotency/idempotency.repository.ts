import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Database,
  type DatabaseTransaction,
} from '@/database/drizzle';
import { idempotencyKeys } from '@/database/schemas/idempotency-keys.schema';

import {
  IDEMPOTENCY_KEY_TTL_SECONDS,
  IDEMPOTENCY_LEASE_SECONDS,
  type IdempotencyKeyStatus,
  type IdempotencyScope,
} from './idempotency.constants';

type IdempotentRequest = {
  scope: IdempotencyScope;
  key: string;
  requestHash: string;
};

type StoredResponse = { statusCode: number; body: object };

type IdempotencyKeyState = {
  requestHash: string;
  status: IdempotencyKeyStatus;
  paymentId: string | null;
  responseStatus: number | null;
  responseBody: object | null;
  isLeaseExpired: boolean;
};

const storedResponseOf = (
  statusCode: number | null,
  body: object | null,
): StoredResponse | null =>
  statusCode === null || body === null ? null : { statusCode, body };

const keyOf = ({ scope, key }: IdempotentRequest) =>
  and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key));

const stateColumns = {
  requestHash: idempotencyKeys.requestHash,
  status: idempotencyKeys.status,
  paymentId: idempotencyKeys.paymentId,
  responseStatus: idempotencyKeys.responseStatus,
  responseBody: idempotencyKeys.responseBody,
  isLeaseExpired: sql<boolean>`${idempotencyKeys.createdAt} <= clock_timestamp() - ${IDEMPOTENCY_LEASE_SECONDS}::integer * interval '1 second'`,
};

@Injectable()
export class IdempotencyRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  withTransaction<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(work);
  }

  // One statement: a concurrent claim of the same key waits for this
  // transaction and then sees a fresh row, so only one request owns the key.
  async claim(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
  ): Promise<boolean> {
    const claimedRows = await tx
      .insert(idempotencyKeys)
      .values({
        scope: request.scope,
        key: request.key,
        requestHash: request.requestHash,
        status: 'in_progress',
      })
      .onConflictDoUpdate({
        target: [idempotencyKeys.scope, idempotencyKeys.key],
        set: {
          requestHash: request.requestHash,
          status: 'in_progress',
          paymentId: null,
          responseStatus: null,
          responseBody: null,
          createdAt: sql`clock_timestamp()`,
          completedAt: null,
        },
        setWhere: sql`${idempotencyKeys.createdAt} <= clock_timestamp() - ${IDEMPOTENCY_KEY_TTL_SECONDS}::integer * interval '1 second'`,
      })
      .returning({ key: idempotencyKeys.key });

    return claimedRows.length > 0;
  }

  async setPaymentId(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
  ): Promise<void> {
    await tx.update(idempotencyKeys).set({ paymentId }).where(keyOf(request));
  }

  async findState(
    request: IdempotentRequest,
  ): Promise<IdempotencyKeyState | null> {
    const [state] = await this.db
      .select(stateColumns)
      .from(idempotencyKeys)
      .where(keyOf(request));

    return state ?? null;
  }

  async findStateForUpdate(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
  ): Promise<IdempotencyKeyState | null> {
    const [state] = await tx
      .select(stateColumns)
      .from(idempotencyKeys)
      .where(keyOf(request))
      .for('update');

    return state ?? null;
  }

  // Fenced by status and payment: a request whose lease was recovered stores nothing.
  async complete(
    tx: DatabaseTransaction,
    request: IdempotentRequest,
    paymentId: string,
    response: StoredResponse,
  ): Promise<StoredResponse | null> {
    const [stored] = await tx
      .update(idempotencyKeys)
      .set({
        status: 'completed',
        responseStatus: response.statusCode,
        responseBody: response.body,
        completedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          keyOf(request),
          eq(idempotencyKeys.status, 'in_progress'),
          eq(idempotencyKeys.paymentId, paymentId),
        ),
      )
      .returning({
        statusCode: idempotencyKeys.responseStatus,
        body: idempotencyKeys.responseBody,
      });
    if (!stored) return null;

    return storedResponseOf(stored.statusCode, stored.body);
  }
}

export { storedResponseOf };
export type { IdempotencyKeyState, IdempotentRequest, StoredResponse };
