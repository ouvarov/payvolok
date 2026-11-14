import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { PaymentsModule } from '@/payments/payments.module';
import { ProviderAccountsModule } from '@/provider-accounts/provider-accounts.module';
import { ProvidersModule } from '@/providers/providers.module';
import { RefundsModule } from '@/refunds/refunds.module';

import { WebhookEventProcessor } from './webhook-event.processor';
import { WebhookWorker } from './webhook.worker';
import { WebhooksController } from './webhooks.controller';
import { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [
    DatabaseModule,
    PaymentsModule,
    ProviderAccountsModule,
    ProvidersModule,
    RefundsModule,
  ],
  controllers: [WebhooksController],
  providers: [
    WebhookEventProcessor,
    WebhookWorker,
    WebhooksRepository,
    WebhooksService,
  ],
})
export class WebhooksModule {}
