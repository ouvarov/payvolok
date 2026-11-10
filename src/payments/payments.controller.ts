import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { RouteAccess } from '@/auth/route-access.decorator';
import { API_V1_PREFIX } from '@/common/api-prefix';

import { PaymentResponseDto } from './dto/payment-response.dto';
import { PaymentsService } from './payments.service';

@RouteAccess('api_key')
@Controller(`${API_V1_PREFIX}/payments`)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get(':id')
  getPayment(
    @Param('id', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentResponseDto> {
    return this.paymentsService.getPayment(paymentId);
  }
}
