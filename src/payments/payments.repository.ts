import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';

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

type ProviderRef = {
  provider: ProviderCode;
  providerAccountId: string;
  providerPaymentId: string;
};

type RecentPaymentCount = {
  count: number;
  secondsUntilOldestLeaves: number | null;
};

const createdWithin = (windowSeconds: number) =>
  sql`${payments.createdAt} > clock_timestamp() - ${windowSeconds}::integer * interval '1 second'`;

@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  withTransaction<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(work);
  }

  async findByIdInProject(
    projectId: string,
    paymentId: string,
  ): Promise<Payment | null> {
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(
        and(eq(payments.id, paymentId), eq(payments.projectId, projectId)),
      );

    return payment ?? null;
  }

  async findDemoPayment(
    projectId: string,
    paymentId: string,
    maxAgeSeconds: number,
  ): Promise<Payment | null> {
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.id, paymentId),
          eq(payments.projectId, projectId),
          sql`${payments.origin} = 'demo'`,
          createdWithin(maxAgeSeconds),
        ),
      );

    return payment ?? null;
  }

  // The origin is a literal so the planner can use the partial demo index.
  async countRecentDemoPayments(
    windowSeconds: number,
  ): Promise<RecentPaymentCount> {
    const [recent] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        secondsUntilOldestLeaves: sql<
          number | null
        >`ceil(extract(epoch from min(${payments.createdAt}) + ${windowSeconds}::integer * interval '1 second' - clock_timestamp()))::int`,
      })
      .from(payments)
      .where(
        and(sql`${payments.origin} = 'demo'`, createdWithin(windowSeconds)),
      );

    return recent;
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

  // LEAST skips NULL, so a stopped row is re-armed while an earlier due time stays.
  async scheduleReconciliation(
    tx: DatabaseTransaction,
    paymentId: string,
    delaySeconds: number,
  ): Promise<void> {
    await tx
      .update(payments)
      .set({
        reconcileAfter: sql`LEAST(${payments.reconcileAfter}, clock_timestamp() + ${delaySeconds}::integer * interval '1 second')`,
      })
      .where(eq(payments.id, paymentId));
  }

  async insertIfAbsent(
    tx: DatabaseTransaction,
    newPayment: NewPayment,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .insert(payments)
      .values(newPayment)
      .onConflictDoNothing({
        target: [payments.providerAccountId, payments.providerPaymentId],
      })
      .returning();

    return payment ?? null;
  }

  async findByProviderRefForUpdate(
    tx: DatabaseTransaction,
    providerAccountId: string,
    providerPaymentId: string,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.providerAccountId, providerAccountId),
          eq(payments.providerPaymentId, providerPaymentId),
        ),
      )
      .for('update');

    return payment ?? null;
  }

  async findProviderRefElsewhere(
    tx: DatabaseTransaction,
    ref: ProviderRef,
  ): Promise<Pick<Payment, 'providerAccountId'> | null> {
    const [payment] = await tx
      .select({ providerAccountId: payments.providerAccountId })
      .from(payments)
      .where(
        and(
          eq(payments.provider, ref.provider),
          eq(payments.providerPaymentId, ref.providerPaymentId),
          ne(payments.providerAccountId, ref.providerAccountId),
        ),
      )
      .limit(1);

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

  async findByIdInProjectForUpdate(
    tx: DatabaseTransaction,
    projectId: string,
    paymentId: string,
  ): Promise<Payment | null> {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.projectId, projectId)))
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

export type { RecentPaymentCount };
