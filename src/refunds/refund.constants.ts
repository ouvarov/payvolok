const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;

const REFUNDS_PROVIDER_REF_UNIQUE =
  'refunds_provider_provider_refund_id_unique';
const REFUNDS_ACCOUNT_PROVIDER_REF_UNIQUE =
  'refunds_provider_account_id_provider_refund_id_unique';

const UNCONFIRMED_REFUND_RECONCILE_DELAY_SECONDS = 120;

type RefundStatus = (typeof REFUND_STATUSES)[number];

export {
  REFUND_STATUSES,
  REFUNDS_ACCOUNT_PROVIDER_REF_UNIQUE,
  REFUNDS_PROVIDER_REF_UNIQUE,
  UNCONFIRMED_REFUND_RECONCILE_DELAY_SECONDS,
};
export type { RefundStatus };
