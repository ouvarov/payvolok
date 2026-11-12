import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

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
import { quotedList } from '@/database/schemas/schema-helpers';
import type { ProviderCode } from '@/providers/provider.constants';

import {
  NUDGEABLE_PAYMENT_STATUSES,
  RECONCILE_LEASE_SECONDS,
  RECONCILE_NUDGE_MIN_AGE_SECONDS,
  RECONCILE_NUDGE_THROTTLE_SECONDS,
  type PaymentStatus,
} from './payment.constants';

@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  withTransaction<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(work);
  }

  async findById(paymentId: string): Promise<Payment | null> {
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));

    return payment ?? null;
  }

  // Only ever brings a check forward: a stopped (NULL), already due or leased
  // row is left alone. A finished check is always scheduled past its lease.
  async requestReconciliation(paymentId: string): Promise<void> {
    await this.db
      .update(payments)
      .set({
        reconcileAfter: sql`LEAST(${payments.reconcileAfter}, clock_timestamp())`,
      })
      .where(
        and(
          eq(payments.id, paymentId),
          sql`${payments.status} IN (${quotedList(NUDGEABLE_PAYMENT_STATUSES)})`,
          sql`${payments.reconcileAfter} > clock_timestamp()`,
          sql`${payments.createdAt} <= clock_timestamp() - ${RECONCILE_NUDGE_MIN_AGE_SECONDS}::integer * interval '1 second'`,
          sql`(${payments.reconciledAt} IS NULL OR ${payments.reconciledAt} <= clock_timestamp() - ${RECONCILE_NUDGE_THROTTLE_SECONDS}::integer * interval '1 second')`,
          sql`(${payments.reconciledAt} IS NULL OR ${payments.reconcileAfter} > ${payments.reconciledAt} + ${RECONCILE_LEASE_SECONDS}::integer * interval '1 second')`,
        ),
      );
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
    provider: ProviderCode,
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

  async findByIdForUpdate(
    tx: DatabaseTransaction,
    paymentId: string,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');

    return payment ?? null;
  }

  async findByIdAndProviderForUpdate(
    tx: DatabaseTransaction,
    paymentId: string,
    provider: ProviderCode,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.provider, provider)))
      .for('update');

    return payment ?? null;
  }

  async setProviderPaymentId(
    tx: DatabaseTransaction,
    paymentId: string,
    providerPaymentId: string,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .update(payments)
      .set({ providerPaymentId, updatedAt: sql`clock_timestamp()` })
      .where(
        and(eq(payments.id, paymentId), isNull(payments.providerPaymentId)),
      )
      .returning();

    return payment ?? null;
  }

  async updateStatus(
    tx: DatabaseTransaction,
    paymentId: string,
    status: PaymentStatus,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .update(payments)
      .set({ status, updatedAt: sql`clock_timestamp()` })
      .where(eq(payments.id, paymentId))
      .returning();

    return payment ?? null;
  }

  async insertEvent(
    tx: DatabaseTransaction,
    newEvent: NewPaymentEvent,
  ): Promise<void> {
    await tx
      .insert(paymentEvents)
      .values(newEvent)
      .onConflictDoNothing({
        target: [
          paymentEvents.webhookEventId,
          paymentEvents.paymentId,
          paymentEvents.toStatus,
        ],
      });
  }
}
