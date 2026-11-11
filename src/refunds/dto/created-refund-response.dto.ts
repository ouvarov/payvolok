import type { Refund } from '@/database/schemas/refunds.schema';

import type { RefundStatus } from '../refund.constants';

export class CreatedRefundResponseDto {
  readonly refundId: string;
  readonly paymentId: string;
  readonly status: RefundStatus;

  constructor(refund: Pick<Refund, 'id' | 'paymentId' | 'status'>) {
    this.refundId = refund.id;
    this.paymentId = refund.paymentId;
    this.status = refund.status;
  }
}
