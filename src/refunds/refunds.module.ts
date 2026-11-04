import { Module } from '@nestjs/common';

import { PaymentsModule } from '@/payments/payments.module';

import { RefundsRepository } from './refunds.repository';
import { RefundsService } from './refunds.service';

@Module({
  imports: [PaymentsModule],
  providers: [RefundsRepository, RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
