import type { ProviderRefundEvent } from '@/providers/provider-events';

import type { RefundStatus } from './refund.constants';

const REFUND_STATUS_BY_EVENT_TYPE = {
  'refund.pending': 'pending',
  'refund.succeeded': 'succeeded',
  'refund.failed': 'failed',
} as const satisfies Record<ProviderRefundEvent['type'], RefundStatus>;

export { REFUND_STATUS_BY_EVENT_TYPE };
