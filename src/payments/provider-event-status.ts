import type { ProviderPaymentEvent } from '@/providers/provider-events';

import type { PaymentStatus } from './payment.constants';

const PAYMENT_STATUS_BY_EVENT_TYPE = {
  'payment.pending': 'pending',
  'payment.attempt_failed': 'pending',
  'payment.succeeded': 'succeeded',
  'payment.failed': 'failed',
  'payment.expired': 'expired',
} as const satisfies Record<ProviderPaymentEvent['type'], PaymentStatus>;

type IngestablePaymentStatus =
  (typeof PAYMENT_STATUS_BY_EVENT_TYPE)[ProviderPaymentEvent['type']];

export { PAYMENT_STATUS_BY_EVENT_TYPE };
export type { IngestablePaymentStatus };
