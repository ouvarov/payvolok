import type { ProviderCode } from './provider.constants';
import type { ProviderEvents } from './provider-events';

type WebhookRequest = {
  rawBody: Buffer;
  // Keys are lowercase header names.
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};

type RecurringModel = 'managed' | 'token' | 'none';
type IntervalUnit = 'day' | 'week' | 'month' | 'year';
type IntervalSupport = { unit: IntervalUnit; maxCount: number | null };
type RefundIdentity = 'provider' | 'reference';

type ProviderCapabilities = {
  recurring: RecurringModel;
  intervals: readonly IntervalSupport[];
  partialRefund: boolean;
  catalog: boolean;
  refundIdentity: RefundIdentity;
};

type ProviderPaymentStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'partially_refunded'
  | 'refunded';

type ProviderRefundStatus = 'pending' | 'succeeded' | 'failed';

type CreatePaymentInput = {
  reference: string;
  amountMinor: number;
  // ISO alpha; adapters map it to a numeric code where the provider needs one.
  currency: string;
  description: string;
  returnUrl: string;
  webhookUrl: string;
};

type CreatedPayment = {
  providerPaymentId: string;
  redirectUrl: string;
  status: ProviderPaymentStatus;
};

type RefundInput = {
  reference: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
};

type CreatedRefund = {
  providerRefundId: string | null;
  status: ProviderRefundStatus;
};

type StatusQuery =
  | { resource: 'payment'; providerPaymentId: string }
  | {
      resource: 'refund';
      providerPaymentId: string;
      providerRefundId: string | null;
      reference: string;
    };

type ResourceStatus =
  | {
      resource: 'payment';
      providerPaymentId: string;
      status: ProviderPaymentStatus;
      amountMinor: number;
      currency: string;
    }
  | {
      resource: 'refund';
      providerRefundId: string | null;
      status: ProviderRefundStatus;
      amountMinor: number;
      currency: string;
    };

type PaymentProvider = {
  readonly code: ProviderCode;
  readonly capabilities: ProviderCapabilities;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  refund(input: RefundInput): Promise<CreatedRefund>;
  // Null means the provider does not know the resource.
  getStatus(query: StatusQuery): Promise<ResourceStatus | null>;
  // Rejects when verification was impossible: an outage must not become a permanent 401.
  verifyWebhook(request: WebhookRequest): Promise<boolean>;
  parseWebhook(request: WebhookRequest): ProviderEvents;
};

type ProviderErrorKind = 'rejected' | 'unavailable' | 'misconfigured';

type ProviderErrorDetails = {
  providerCode: ProviderCode;
  kind: ProviderErrorKind;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly providerCode: ProviderCode;
  readonly kind: ProviderErrorKind;

  constructor(message: string, details: ProviderErrorDetails) {
    super(message, details);
    this.name = 'ProviderError';
    this.providerCode = details.providerCode;
    this.kind = details.kind;
  }

  get isRetryable(): boolean {
    return this.kind === 'unavailable';
  }
}

export type {
  CreatedPayment,
  CreatedRefund,
  CreatePaymentInput,
  IntervalSupport,
  IntervalUnit,
  PaymentProvider,
  ProviderCapabilities,
  ProviderErrorDetails,
  ProviderErrorKind,
  ProviderPaymentStatus,
  ProviderRefundStatus,
  RecurringModel,
  RefundIdentity,
  RefundInput,
  ResourceStatus,
  StatusQuery,
  WebhookRequest,
};
