import { z } from 'zod';

import { CURRENCY_PATTERN } from '@/common/currency';

import type {
  CreatedPayment,
  CreatedRefund,
  CreatePaymentInput,
  PaymentProvider,
  ProviderCapabilities,
  ProviderError,
  ProviderRefundStatus,
  RefundInput,
  ResourceStatus,
  StatusQuery,
  WebhookRequest,
} from '../payment-provider.port';
import { dedupKeyFromBody, type ProviderEvents } from '../provider-events';

import {
  isOk,
  paddleError,
  paddleErrorOf,
  sendPaddleRequest,
  type PaddleRequest,
  type PaddleResponse,
} from './paddle-http';
import { isSignatureValid } from './paddle-signature';
import {
  ADJUSTMENT_ID_PATTERN,
  ADJUSTMENT_STATUSES,
  paddleAdjustmentPageSchema,
  paddleAdjustmentSchema,
  paddleCreatedTransactionSchema,
  paddleEnvelopeSchema,
  paddleRefundableTransactionSchema,
  paddleTransactionSchema,
  parseJsonOrNull,
  toProviderEvent,
  TRANSACTION_ID_PATTERN,
  TRANSACTION_STATUSES,
  type PaddleAdjustment,
  type PaddleRefundableTransaction,
} from './paddle-wire-format';

type PaddleConfig = {
  apiKey: string | null;
  webhookSecret: string | null;
};

const SIGNATURE_HEADER = 'paddle-signature';
const PRODUCT_NAME_MAX_LENGTH = 200;
const REFUND_REASON = 'api_refund';
const HTTP_NOT_FOUND = 404;
const ADJUSTMENTS_PAGE_SIZE = 50;
const RESERVING_ADJUSTMENT_STATUSES: readonly string[] = [
  'pending_approval',
  'approved',
];

const PADDLE_CAPABILITIES: ProviderCapabilities = {
  recurring: 'managed',
  intervals: [],
  partialRefund: true,
  catalog: true,
  refundIdentity: 'provider',
};

const rejectedError = (message: string): ProviderError =>
  paddleError(message, 'rejected');

const isPositiveAmount = (amountMinor: number): boolean =>
  Number.isSafeInteger(amountMinor) && amountMinor > 0;

const isHttpsUrl = (text: string): boolean =>
  URL.canParse(text) && new URL(text).protocol === 'https:';

const transactionBodyOf = (input: CreatePaymentInput) => ({
  items: [
    {
      quantity: 1,
      price: {
        description: input.description,
        unit_price: {
          amount: String(input.amountMinor),
          currency_code: input.currency,
        },
        tax_mode: 'internal',
        product: {
          name: input.description.slice(0, PRODUCT_NAME_MAX_LENGTH),
          tax_category: 'standard',
        },
      },
    },
  ],
  currency_code: input.currency,
  custom_data: { reference: input.reference },
});

const adjustmentBodyOf = (
  transaction: PaddleRefundableTransaction,
  amountMinor: number,
  refundedMinor: number,
) => {
  if (
    refundedMinor === 0 &&
    amountMinor === transaction.details.totals.grand_total
  ) {
    return {
      action: 'refund',
      type: 'full',
      transaction_id: transaction.id,
      reason: REFUND_REASON,
    };
  }

  const [lineItem, ...otherLineItems] = transaction.details.line_items;
  if (!lineItem || otherLineItems.length > 0) {
    throw rejectedError('Partial refund needs exactly one line item');
  }

  return {
    action: 'refund',
    type: 'partial',
    tax_mode: 'internal',
    transaction_id: transaction.id,
    reason: REFUND_REASON,
    items: [
      { item_id: lineItem.id, type: 'partial', amount: String(amountMinor) },
    ],
  };
};

const adjustmentStatusOf = (
  adjustment: PaddleAdjustment,
): ProviderRefundStatus => {
  const status = ADJUSTMENT_STATUSES.get(adjustment.status);
  if (!status) {
    throw paddleError(
      `paddle adjustment ${adjustment.id} has status ${adjustment.status}`,
      'unavailable',
    );
  }

  return status;
};

const dataEnvelopeSchema = z.object({ data: z.unknown() });

const bodyOf = <Output>(
  schema: z.ZodType<Output>,
  response: PaddleResponse,
): Output => {
  if (!isOk(response)) throw paddleErrorOf(response);

  const body = schema.safeParse(response.body);
  if (!body.success) {
    throw paddleError(
      `paddle ${response.status} answer does not match the expected shape`,
      'unavailable',
    );
  }

  return body.data;
};

const dataOf = <Output>(
  schema: z.ZodType<Output>,
  response: PaddleResponse,
): Output => {
  const { data } = bodyOf(dataEnvelopeSchema, response);

  return bodyOf(schema, { status: response.status, body: data });
};

const reservedRefundMinorOf = (adjustments: PaddleAdjustment[]): number =>
  adjustments
    .filter(
      ({ action, status }) =>
        action === 'refund' && RESERVING_ADJUSTMENT_STATUSES.includes(status),
    )
    .reduce((sum, { totals }) => sum + totals.total, 0);

const unknownBodyEvents = (rawBody: Buffer): ProviderEvents => [
  {
    type: 'unknown',
    rawType: null,
    dedupKey: dedupKeyFromBody(rawBody),
    occurredAt: null,
  },
];

export class PaddleProvider implements PaymentProvider {
  readonly code = 'paddle';
  readonly capabilities = PADDLE_CAPABILITIES;
  readonly webhookHeaders = [SIGNATURE_HEADER];

  constructor(
    private readonly config: PaddleConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly nowEpochMs: () => number = Date.now,
  ) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    if (
      !isPositiveAmount(input.amountMinor) ||
      !CURRENCY_PATTERN.test(input.currency)
    ) {
      throw rejectedError('Payment amount or currency is invalid');
    }

    const response = await this.send({
      method: 'POST',
      path: '/transactions',
      body: transactionBodyOf(input),
    });
    const transaction = dataOf(paddleCreatedTransactionSchema, response);
    const checkoutUrl = transaction.checkout?.url ?? null;
    if (checkoutUrl === null) {
      throw paddleError(
        `paddle transaction ${transaction.id} has no checkout url`,
        'misconfigured',
      );
    }
    if (!isHttpsUrl(checkoutUrl)) {
      throw paddleError(
        `paddle transaction ${transaction.id} has a checkout url that is not https`,
        'unavailable',
      );
    }

    return {
      providerPaymentId: transaction.id,
      redirectUrl: checkoutUrl,
      status: 'pending',
    };
  }

  async refund(input: RefundInput): Promise<CreatedRefund> {
    if (
      !isPositiveAmount(input.amountMinor) ||
      !CURRENCY_PATTERN.test(input.currency) ||
      !TRANSACTION_ID_PATTERN.test(input.providerPaymentId)
    ) {
      throw rejectedError('Refund amount, currency or payment id is invalid');
    }

    const transaction = dataOf(
      paddleRefundableTransactionSchema,
      await this.send({
        method: 'GET',
        path: `/transactions/${input.providerPaymentId}`,
      }),
    );
    if (transaction.status !== 'completed') {
      throw rejectedError(`Transaction is ${transaction.status}`);
    }
    if (transaction.currency_code !== input.currency) {
      throw rejectedError('Refund currency differs');
    }

    // Our refund rows miss an adjustment whose POST timed out, so Paddle's own list decides.
    const refundedMinor = await this.refundedMinorOf(transaction.id);
    if (
      input.amountMinor >
      transaction.details.totals.grand_total - refundedMinor
    ) {
      throw rejectedError('Refund exceeds the amount Paddle has left');
    }

    const adjustment = dataOf(
      paddleAdjustmentSchema,
      await this.send({
        method: 'POST',
        path: '/adjustments',
        body: adjustmentBodyOf(transaction, input.amountMinor, refundedMinor),
      }),
    );

    return {
      providerRefundId: adjustment.id,
      status: adjustmentStatusOf(adjustment),
    };
  }

  getStatus(query: StatusQuery): Promise<ResourceStatus | null> {
    return query.resource === 'payment'
      ? this.paymentStatusOf(query.providerPaymentId)
      : this.refundStatusOf(query);
  }

  verifyWebhook(request: WebhookRequest): Promise<boolean> {
    if (this.config.webhookSecret === null) {
      return Promise.reject(
        paddleError('PADDLE_WEBHOOK_SECRET is not configured', 'misconfigured'),
      );
    }

    return Promise.resolve(
      isSignatureValid(
        request.headers[SIGNATURE_HEADER],
        request.rawBody,
        this.config.webhookSecret,
        this.nowEpochMs(),
      ),
    );
  }

  parseWebhook(request: WebhookRequest): ProviderEvents {
    const envelope = paddleEnvelopeSchema.safeParse(
      parseJsonOrNull(request.rawBody.toString('utf8')),
    );
    if (!envelope.success) return unknownBodyEvents(request.rawBody);

    return [toProviderEvent(envelope.data)];
  }

  private async refundedMinorOf(transactionId: string): Promise<number> {
    const page = bodyOf(
      paddleAdjustmentPageSchema,
      await this.send({
        method: 'GET',
        path: '/adjustments',
        query: {
          transaction_id: transactionId,
          action: 'refund',
          per_page: String(ADJUSTMENTS_PAGE_SIZE),
        },
      }),
    );
    if (page.meta.pagination.has_more) {
      throw paddleError(
        `paddle transaction ${transactionId} has more refund adjustments than one page`,
        'unavailable',
      );
    }

    return reservedRefundMinorOf(page.data);
  }

  private async paymentStatusOf(
    providerPaymentId: string,
  ): Promise<ResourceStatus | null> {
    if (!TRANSACTION_ID_PATTERN.test(providerPaymentId)) return null;

    const response = await this.send({
      method: 'GET',
      path: `/transactions/${providerPaymentId}`,
    });
    if (response.status === HTTP_NOT_FOUND) return null;

    const transaction = dataOf(paddleTransactionSchema, response);
    const status = TRANSACTION_STATUSES.get(transaction.status);
    if (!status) {
      throw paddleError(
        `paddle transaction ${transaction.id} has status ${transaction.status}`,
        'unavailable',
      );
    }

    return {
      resource: 'payment',
      providerPaymentId: transaction.id,
      status,
      amountMinor: transaction.details.totals.total,
      currency: transaction.currency_code,
    };
  }

  private async refundStatusOf(
    query: Extract<StatusQuery, { resource: 'refund' }>,
  ): Promise<ResourceStatus | null> {
    const { providerRefundId, providerPaymentId } = query;
    if (
      providerRefundId === null ||
      !ADJUSTMENT_ID_PATTERN.test(providerRefundId) ||
      !TRANSACTION_ID_PATTERN.test(providerPaymentId)
    ) {
      return null;
    }

    const adjustments = dataOf(
      paddleAdjustmentSchema.array(),
      await this.send({
        method: 'GET',
        path: '/adjustments',
        query: { id: providerRefundId, transaction_id: providerPaymentId },
      }),
    );
    const adjustment = adjustments.find(({ id }) => id === providerRefundId);
    if (!adjustment) return null;

    return {
      resource: 'refund',
      providerRefundId: adjustment.id,
      status: adjustmentStatusOf(adjustment),
      amountMinor: adjustment.totals.total,
      currency: adjustment.currency_code,
    };
  }

  private send(request: PaddleRequest): Promise<PaddleResponse> {
    if (this.config.apiKey === null) {
      return Promise.reject(
        paddleError('PADDLE_API_KEY is not configured', 'misconfigured'),
      );
    }

    return sendPaddleRequest(this.fetchFn, this.config.apiKey, request);
  }
}

export type { PaddleConfig };
