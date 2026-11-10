import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';

import { RouteAccess } from '@/auth/route-access.decorator';
import { API_V1_PREFIX } from '@/common/api-prefix';
import type { IdempotentResponse } from '@/idempotency/idempotency.service';
import { IdempotencyKey } from '@/idempotency/idempotency-key.decorator';
import { IdempotentResponseInterceptor } from '@/idempotency/idempotent-response.interceptor';

import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundCreationService } from './refund-creation.service';

@RouteAccess('api_key')
@Controller(`${API_V1_PREFIX}/payments/:paymentId/refunds`)
export class RefundsController {
  constructor(private readonly refundCreationService: RefundCreationService) {}

  @Post()
  @UseInterceptors(IdempotentResponseInterceptor)
  createRefund(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() createRefundDto: CreateRefundDto,
  ): Promise<IdempotentResponse> {
    return this.refundCreationService.createRefund(
      idempotencyKey,
      paymentId,
      createRefundDto,
    );
  }
}
