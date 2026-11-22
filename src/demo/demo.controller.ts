import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { hours, minutes, Throttle } from '@nestjs/throttler';

import { RouteAccess } from '@/auth/route-access.decorator';
import { API_DEMO_PREFIX } from '@/common/api-prefix';
import type { IdempotentResponse } from '@/idempotency/idempotency.service';
import { IdempotencyKey } from '@/idempotency/idempotency-key.decorator';
import { IdempotentResponseInterceptor } from '@/idempotency/idempotent-response.interceptor';
import { PaymentResponseDto } from '@/payments/dto/payment-response.dto';

import {
  DEMO_CREATE_LIMIT_PER_HOUR,
  DEMO_READ_LIMIT_PER_MINUTE,
} from './demo.constants';
import { DemoService } from './demo.service';
import { DemoThrottlerGuard } from './demo-throttler.guard';
import { DemoToken } from './demo-token.decorator';
import { CreateDemoPaymentDto } from './dto/create-demo-payment.dto';

// Public: the only secret is the demoToken a create answer hands out.
@RouteAccess('public')
@UseGuards(DemoThrottlerGuard)
@Controller(`${API_DEMO_PREFIX}/payments`)
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Post()
  @Throttle({
    default: { limit: DEMO_CREATE_LIMIT_PER_HOUR, ttl: hours(1) },
  })
  @UseInterceptors(IdempotentResponseInterceptor)
  createPayment(
    @IdempotencyKey() idempotencyKey: string,
    @Body() createDemoPaymentDto: CreateDemoPaymentDto,
  ): Promise<IdempotentResponse> {
    return this.demoService.createPayment(idempotencyKey, createDemoPaymentDto);
  }

  @Get(':paymentId')
  @Throttle({
    default: { limit: DEMO_READ_LIMIT_PER_MINUTE, ttl: minutes(1) },
  })
  getPayment(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @DemoToken() demoToken: string | undefined,
  ): Promise<PaymentResponseDto> {
    return this.demoService.getPayment(paymentId, demoToken);
  }
}
