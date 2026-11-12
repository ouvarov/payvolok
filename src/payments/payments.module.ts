import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { ProvidersModule } from '@/providers/providers.module';

import { PaymentCreationService } from './payment-creation.service';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

@Module({
  imports: [DatabaseModule, IdempotencyModule, ProvidersModule],
  controllers: [PaymentsController],
  providers: [PaymentCreationService, PaymentsRepository, PaymentsService],
  exports: [PaymentCreationService, PaymentsService],
})
export class PaymentsModule {}
