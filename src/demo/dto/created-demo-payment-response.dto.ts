import type { CreatedPaymentResponseDto } from '@/payments/dto/created-payment-response.dto';

export class CreatedDemoPaymentResponseDto {
  readonly paymentId: string;
  readonly checkout: CreatedPaymentResponseDto['checkout'];
  readonly demoToken: string;

  constructor(created: CreatedPaymentResponseDto, demoToken: string) {
    this.paymentId = created.paymentId;
    this.checkout = created.checkout;
    this.demoToken = demoToken;
  }
}
