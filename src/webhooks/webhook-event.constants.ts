const WEBHOOK_EVENT_STATUSES = [
  'received',
  'processed',
  'ignored',
  'failed',
] as const;

type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export { WEBHOOK_EVENT_STATUSES };
export type { WebhookEventStatus };
