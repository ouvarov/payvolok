import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Database,
  type DatabaseTransaction,
} from '@/database/drizzle';
import {
  refunds,
  type NewRefund,
  type Refund,
} from '@/database/schemas/refunds.schema';
import type { ProviderCode } from '@/providers/provider.constants';

import type { RefundStatus } from './refund.constants';

const sumMinorWithStatus = async (
  tx: DatabaseTransaction,
  paymentId: string,
  statuses: readonly RefundStatus[],
): Promise<number> => {
  const [{ totalMinor }] = await tx
    .select({
      totalMinor: sql`coalesce(sum(${refunds.amountMinor}), 0)`.mapWith(Number),
    })
    .from(refunds)
    .where(
      and(eq(refunds.paymentId, paymentId), inArray(refunds.status, statuses)),
    );

  return totalMinor;
};

@Injectable()
export class RefundsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  findPendingByPayment(paymentId: string): Promise<Refund[]> {
    return this.db
      .select()
      .from(refunds)
      .where(
        and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'pending')),
      )
      .orderBy(asc(refunds.createdAt), asc(refunds.id));
  }

  async insertIfAbsent(
    tx: DatabaseTransaction,
    newRefund: NewRefund,
  ): Promise<Refund | null> {
    const [refund] = await tx
      .insert(refunds)
      .values(newRefund)
      .onConflictDoNothing()
      .returning();

    return refund ?? null;
  }

  async findById(
    tx: DatabaseTransaction,
    refundId: string,
  ): Promise<Refund | null> {
    const [refund] = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.id, refundId));

    return refund ?? null;
  }

  async findByIdAndPayment(
    tx: DatabaseTransaction,
    refundId: string,
    paymentId: string,
  ): Promise<Refund | null> {
    const [refund] = await tx
      .select()
      .from(refunds)
      .where(and(eq(refunds.id, refundId), eq(refunds.paymentId, paymentId)));

    return refund ?? null;
  }

  async findByProviderRef(
    tx: DatabaseTransaction,
    provider: ProviderCode,
    providerRefundId: string,
  ): Promise<Refund | null> {
    const [refund] = await tx
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.provider, provider),
          eq(refunds.providerRefundId, providerRefundId),
        ),
      );

    return refund ?? null;
  }

  async setProviderRefundId(
    tx: DatabaseTransaction,
    refundId: string,
    providerRefundId: string,
  ): Promise<Refund | null> {
    const [refund] = await tx
      .update(refunds)
      .set({ providerRefundId, updatedAt: sql`clock_timestamp()` })
      .where(eq(refunds.id, refundId))
      .returning();

    return refund ?? null;
  }

  async updateStatus(
    tx: DatabaseTransaction,
    refundId: string,
    status: RefundStatus,
  ): Promise<Refund | null> {
    const [refund] = await tx
      .update(refunds)
      .set({ status, updatedAt: sql`clock_timestamp()` })
      .where(eq(refunds.id, refundId))
      .returning();

    return refund ?? null;
  }

  sumSucceededMinor(
    tx: DatabaseTransaction,
    paymentId: string,
  ): Promise<number> {
    return sumMinorWithStatus(tx, paymentId, ['succeeded']);
  }

  sumReservedMinor(
    tx: DatabaseTransaction,
    paymentId: string,
  ): Promise<number> {
    return sumMinorWithStatus(tx, paymentId, ['succeeded', 'pending']);
  }
}
