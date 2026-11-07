import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { ProvidersModule } from '@/providers/providers.module';

import { WebhooksController } from './webhooks.controller';
import { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [DatabaseModule, ProvidersModule],
  controllers: [WebhooksController],
  providers: [WebhooksRepository, WebhooksService],
})
export class WebhooksModule {}
