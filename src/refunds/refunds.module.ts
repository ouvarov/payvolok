import { Module } from '@nestjs/common';

import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { PaymentsModule } from '@/payments/payments.module';
import { ProvidersModule } from '@/providers/providers.module';

import { RefundCreationService } from './refund-creation.service';
import { RefundsController } from './refunds.controller';
import { RefundsRepository } from './refunds.repository';
import { RefundsService } from './refunds.service';

@Module({
  imports: [IdempotencyModule, PaymentsModule, ProvidersModule],
  controllers: [RefundsController],
  providers: [RefundCreationService, RefundsRepository, RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
