import type { Type } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { ReconciliationRepository } from '@/reconciliation/reconciliation.repository';

type ScopedReconciliation = {
  paymentIds: Set<string>;
  override: { provide: Type<unknown>; useClass: Type<unknown> };
};

// The e2e database is shared with other spec files and earlier runs, whose
// payments fall due too; a drain in a spec must see only that spec's payments.
const scopedReconciliation = (): ScopedReconciliation => {
  const paymentIds = new Set<string>();

  class TestScopedReconciliationRepository extends ReconciliationRepository {
    protected claimableRows(): SQL {
      if (paymentIds.size === 0) return sql`false`;

      return sql`id IN (${sql.join(
        [...paymentIds].map((paymentId) => sql`${paymentId}::uuid`),
        sql`, `,
      )})`;
    }
  }

  return {
    paymentIds,
    override: {
      provide: ReconciliationRepository,
      useClass: TestScopedReconciliationRepository,
    },
  };
};

export { scopedReconciliation };
