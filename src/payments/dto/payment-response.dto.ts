import type { Payment } from '@/database/schemas/payments.schema';
import type { ProviderCode } from '@/providers/provider.constants';

import type { PaymentStatus } from '../payment.constants';

export class PaymentResponseDto {
  readonly paymentId: string;
  readonly status: PaymentStatus;
  readonly provider: ProviderCode;
  readonly amountMinor: number;
  readonly currency: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(payment: Payment) {
    this.paymentId = payment.id;
    this.status = payment.status;
    this.provider = payment.provider;
    this.amountMinor = payment.amountMinor;
    this.currency = payment.currency;
    this.createdAt = payment.createdAt;
    this.updatedAt = payment.updatedAt;
  }
}
