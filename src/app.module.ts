import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AccessGuard } from './auth/access.guard';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { validateEnv } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PaymentsModule } from './payments/payments.module';
import { ProvidersModule } from './providers/providers.module';
import { RefundsModule } from './refunds/refunds.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    DatabaseModule,
    HealthModule,
    PaymentsModule,
    ProvidersModule,
    RefundsModule,
    WebhooksModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
