import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { DRIZZLE, type Database } from '@/database/drizzle';
import { payments, type Payment } from '@/database/schemas/payments.schema';
import { quotedList } from '@/database/schemas/schema-helpers';
import type { ProviderCode } from '@/providers/provider.constants';

import {
  RECONCILABLE_PAYMENT_STATUSES,
  RECONCILE_LEASE_SECONDS,
} from './reconciliation.constants';

// The unit a provider outage is skipped by; a provider account once there is more than one.
type ReconciliationScopeKey = ProviderCode;

type ClaimedPayment = Pick<
  Payment,
  | 'id'
  | 'provider'
  | 'providerPaymentId'
  | 'status'
  | 'purpose'
  | 'createdAt'
  | 'reconcileAttempts'
> & { reconciledAt: Date };

const reconciliationScopeKeyOf = (
  payment: Pick<ClaimedPayment, 'provider'>,
): ReconciliationScopeKey => payment.provider;

const outsideScopes = (scopeKeys: readonly ReconciliationScopeKey[]): SQL =>
  scopeKeys.length === 0
    ? sql`true`
    : sql`provider NOT IN (${sql.join(
        scopeKeys.map((scopeKey) => sql`${scopeKey}`),
        sql`, `,
      )})`;

@Injectable()
export class ReconciliationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // One autocommit statement, so the provider call that follows holds no
  // connection. The status list is a literal to match the partial index.
  async claimNext(
    skippedScopeKeys: readonly ReconciliationScopeKey[],
  ): Promise<ClaimedPayment | null> {
    const [claimed] = await this.db
      .update(payments)
      .set({
        reconcileAttempts: sql`${payments.reconcileAttempts} + 1`,
        reconciledAt: sql`clock_timestamp()`,
        reconcileAfter: sql`clock_timestamp() + ${RECONCILE_LEASE_SECONDS}::integer * interval '1 second'`,
      })
      .where(
        sql`${payments.id} = (
          SELECT id FROM payments
          WHERE status IN (${quotedList(RECONCILABLE_PAYMENT_STATUSES)})
            AND reconcile_after <= now()
            AND ${outsideScopes(skippedScopeKeys)}
            AND ${this.claimableRows()}
          ORDER BY reconcile_after, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )`,
      )
      .returning({
        id: payments.id,
        provider: payments.provider,
        providerPaymentId: payments.providerPaymentId,
        status: payments.status,
        purpose: payments.purpose,
        createdAt: payments.createdAt,
        reconcileAttempts: payments.reconcileAttempts,
        reconciledAt: payments.reconciledAt,
      });
    if (!claimed?.reconciledAt) return null;

    return { ...claimed, reconciledAt: claimed.reconciledAt };
  }

  // Fenced by attempts: a check whose lease expired and was reclaimed changes nothing.
  async finish(
    claimed: ClaimedPayment,
    nextReconcileAfter: Date | null,
  ): Promise<boolean> {
    const finishedRows = await this.db
      .update(payments)
      .set({ reconcileAfter: nextReconcileAfter })
      .where(
        and(
          eq(payments.id, claimed.id),
          eq(payments.reconcileAttempts, claimed.reconcileAttempts),
        ),
      )
      .returning({ id: payments.id });

    return finishedRows.length > 0;
  }

  // Every row is claimable; e2e tests on a shared database narrow it to their own rows.
  protected claimableRows(): SQL {
    return sql`true`;
  }
}

export { reconciliationScopeKeyOf };
export type { ClaimedPayment, ReconciliationScopeKey };
