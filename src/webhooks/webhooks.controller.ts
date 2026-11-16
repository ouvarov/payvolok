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

  @Post('paddle')
  @HttpCode(HttpStatus.OK)
  async receiveOnPaddleAlias(
    @Body() body: unknown,
    @Headers() headers: IncomingHttpHeaders,
  ): Promise<{ received: true }> {
    await this.webhooksService.receiveOnPaddleAlias(body, headers);

    return { received: true };
  }

  @Post(':provider/:providerAccountId')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('provider') providerCode: string,
    @Param('providerAccountId') providerAccountId: string,
    @Body() body: unknown,
    @Headers() headers: IncomingHttpHeaders,
  ): Promise<{ received: true }> {
    await this.webhooksService.receive(
      providerCode,
      providerAccountId,
      body,
      headers,
    );

    return { received: true };
  }
}
