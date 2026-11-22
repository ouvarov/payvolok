import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';

import { CurrentProject } from '@/auth/current-project.decorator';
import { RouteAccess } from '@/auth/route-access.decorator';
import { API_V1_PREFIX } from '@/common/api-prefix';
import type { IdempotentResponse } from '@/idempotency/idempotency.service';
import { IdempotencyKey } from '@/idempotency/idempotency-key.decorator';
import { IdempotentResponseInterceptor } from '@/idempotency/idempotent-response.interceptor';

import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';
import { PaymentCreationService } from './payment-creation.service';
import { PaymentsService } from './payments.service';

@RouteAccess('project_key')
@Controller(`${API_V1_PREFIX}/payments`)
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly paymentCreationService: PaymentCreationService,
  ) {}

  @Post()
  @UseInterceptors(IdempotentResponseInterceptor)
  createPayment(
    @CurrentProject() projectId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() createPaymentDto: CreatePaymentDto,
  ): Promise<IdempotentResponse> {
    return this.paymentCreationService.createPayment({
      projectId,
      origin: 'api',
      idempotencyKey,
      payment: createPaymentDto,
    });
  }

  @Get(':id')
  getPayment(
    @CurrentProject() projectId: string,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    return this.paymentsService.getPayment(projectId, paymentId);
  }
}
