import { Module } from '@nestjs/common';
import { minutes, ThrottlerModule } from '@nestjs/throttler';

import { PaymentsModule } from '@/payments/payments.module';

import { DEMO_READ_LIMIT_PER_MINUTE } from './demo.constants';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

// In memory: one instance serves the API, and the daily limit in Postgres is the real budget guard.
@Module({
  imports: [
    PaymentsModule,
    ThrottlerModule.forRoot([
      { ttl: minutes(1), limit: DEMO_READ_LIMIT_PER_MINUTE },
    ]),
  ],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
