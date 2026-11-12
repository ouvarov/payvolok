import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { PaymentsModule } from '@/payments/payments.module';
import { ProvidersModule } from '@/providers/providers.module';

import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationWorker } from './reconciliation.worker';

@Module({
  imports: [DatabaseModule, IdempotencyModule, PaymentsModule, ProvidersModule],
  providers: [
    ReconciliationRepository,
    ReconciliationService,
    ReconciliationWorker,
  ],
})
export class ReconciliationModule {}
