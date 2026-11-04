import type { ProviderPaymentEvent } from '@/providers/provider-events';

import type { PaymentStatus } from './payment.constants';

const PAYMENT_STATUS_BY_EVENT_TYPE: Record<
  ProviderPaymentEvent['type'],
  PaymentStatus
> = {
  'payment.pending': 'pending',
  'payment.attempt_failed': 'pending',
  'payment.succeeded': 'succeeded',
  'payment.failed': 'failed',
  'payment.expired': 'expired',
};

export { PAYMENT_STATUS_BY_EVENT_TYPE };
