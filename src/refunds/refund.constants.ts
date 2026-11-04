const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;

const REFUNDS_PROVIDER_REF_UNIQUE =
  'refunds_provider_provider_refund_id_unique';

type RefundStatus = (typeof REFUND_STATUSES)[number];

export { REFUND_STATUSES, REFUNDS_PROVIDER_REF_UNIQUE };
export type { RefundStatus };
