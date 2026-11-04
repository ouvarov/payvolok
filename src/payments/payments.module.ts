import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';

import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

@Module({
  imports: [DatabaseModule],
  providers: [PaymentsRepository, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
