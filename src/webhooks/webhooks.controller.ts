import type { IncomingHttpHeaders } from 'node:http';

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { RouteAccess } from '@/auth/route-access.decorator';

import { WebhooksService } from './webhooks.service';

// Providers cannot hold our key; WebhooksService checks each delivery's signature.
@RouteAccess('public')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('provider') providerCode: string,
    @Body() body: unknown,
    @Headers() headers: IncomingHttpHeaders,
  ): Promise<{ received: true }> {
    await this.webhooksService.receive(providerCode, body, headers);

    return { received: true };
  }
}
