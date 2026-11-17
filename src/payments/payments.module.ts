import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { ProjectsModule } from '@/projects/projects.module';
import { ProviderAccountsModule } from '@/provider-accounts/provider-accounts.module';

import { PaymentCreationService } from './payment-creation.service';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

@Module({
  imports: [
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    ProviderAccountsModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentCreationService, PaymentsRepository, PaymentsService],
  exports: [PaymentCreationService, PaymentsService],
})
export class PaymentsModule {}
