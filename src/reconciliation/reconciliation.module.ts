import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { PaymentsModule } from '@/payments/payments.module';
import { ProviderAccountsModule } from '@/provider-accounts/provider-accounts.module';
import { RefundsModule } from '@/refunds/refunds.module';

import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationWorker } from './reconciliation.worker';
import { RefundReconciliationService } from './refund-reconciliation.service';

@Module({
  imports: [
    DatabaseModule,
    IdempotencyModule,
    PaymentsModule,
    ProviderAccountsModule,
    RefundsModule,
  ],
  providers: [
    ReconciliationRepository,
    ReconciliationService,
    ReconciliationWorker,
    RefundReconciliationService,
  ],
})
export class ReconciliationModule {}
