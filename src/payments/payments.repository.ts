import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import {
  DRIZZLE,
  type Database,
  type DatabaseTransaction,
} from '@/database/drizzle';
import {
  paymentEvents,
  payments,
  type NewPayment,
  type NewPaymentEvent,
  type Payment,
} from '@/database/schemas/payments.schema';

import type { PaymentStatus } from './payment.constants';

@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  withTransaction<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(work);
  }

  async insertIfAbsent(
    tx: DatabaseTransaction,
    newPayment: NewPayment,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .insert(payments)
      .values(newPayment)
      .onConflictDoNothing({
        target: [payments.provider, payments.providerPaymentId],
      })
      .returning();

    return payment ?? null;
  }

  async findByProviderRefForUpdate(
    tx: DatabaseTransaction,
    provider: string,
    providerPaymentId: string,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.provider, provider),
          eq(payments.providerPaymentId, providerPaymentId),
        ),
      )
      .for('update');

    return payment ?? null;
  }

  async updateStatus(
    tx: DatabaseTransaction,
    paymentId: string,
    status: PaymentStatus,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .update(payments)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(payments.id, paymentId))
      .returning();

    return payment ?? null;
  }

  async insertEvent(
    tx: DatabaseTransaction,
    newEvent: NewPaymentEvent,
  ): Promise<void> {
    await tx.insert(paymentEvents).values(newEvent).onConflictDoNothing();
  }
}
