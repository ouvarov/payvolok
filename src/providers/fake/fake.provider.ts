import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  ProviderError,
  type CreatedPayment,
  type CreatedRefund,
  type CreatePaymentInput,
  type PaymentProvider,
  type ProviderCapabilities,
  type RefundInput,
  type ResourceStatus,
  type StatusQuery,
  type WebhookRequest,
} from '../payment-provider.port';
import {
  dedupKeyFromBody,
  type ProviderEvent,
  type ProviderEvents,
  type ProviderPaymentEvent,
} from '../provider-events';

import {
  decodeFakePaymentId,
  decodeFakeRefundId,
  encodeFakeId,
  fakePaymentIdentitySchema,
  fakeWireBodySchema,
  fakeWireEventSchema,
  fakeWireEventTypeSchema,
  parseJsonOrNull,
  paymentScenarioFor,
  refundScenarioFor,
  type FakeWireBody,
} from './fake-scenarios';

type EventContext = { dedupKey: string; occurredAt: string | null };

const SIGNATURE_HEADER = 'x-fake-signature';
const STEP_INTERVAL_MS = 1000;
const FAKE_DECLINE_REASON = 'fake_declined';

const FAKE_CAPABILITIES: ProviderCapabilities = {
  recurring: 'none',
  intervals: [],
  partialRefund: true,
  catalog: false,
};

const nonRetryableError = (message: string): ProviderError =>
  new ProviderError(message, { providerCode: 'fake', isRetryable: false });

const eventIdOf = (
  resourceId: string,
  eventType: string,
  stepIndex: number,
): string =>
  createHash('sha256')
    .update(`${resourceId}:${eventType}:${stepIndex}`)
    .digest('hex');

const failureReasonOf = (type: ProviderPaymentEvent['type']): string | null =>
  type === 'payment.failed' || type === 'payment.attempt_failed'
    ? FAKE_DECLINE_REASON
    : null;

const toProviderEvent = (
  wireEvent: unknown,
  context: EventContext,
): ProviderEvent => {
  const parsedEvent = fakeWireEventSchema.safeParse(wireEvent);
  if (parsedEvent.success) return { ...parsedEvent.data, ...context };

  const parsedType = fakeWireEventTypeSchema.safeParse(wireEvent);

  return {
    ...context,
    type: 'unknown',
    rawType: parsedType.success ? parsedType.data.type : null,
  };
};

const paymentStatusOf = (providerPaymentId: string): ResourceStatus | null => {
  const payment = decodeFakePaymentId(providerPaymentId);
  if (!payment) return null;

  return {
    resource: 'payment',
    providerPaymentId,
    status: paymentScenarioFor(payment.amountMinor).finalStatus,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
  };
};

const refundStatusOf = (
  query: Extract<StatusQuery, { resource: 'refund' }>,
): ResourceStatus | null => {
  if (query.providerRefundId === null) return null;

  const refund = decodeFakeRefundId(query.providerRefundId);
  if (
    !refund ||
    refund.providerPaymentId !== query.providerPaymentId ||
    refund.reference !== query.reference
  ) {
    return null;
  }

  return {
    resource: 'refund',
    providerRefundId: query.providerRefundId,
    status: refundScenarioFor(refund.amountMinor).finalStatus,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
  };
};

export class FakeProvider implements PaymentProvider {
  readonly code = 'fake';
  readonly capabilities = FAKE_CAPABILITIES;

  constructor(private readonly webhookSecret: Buffer) {}

  createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const identity = fakePaymentIdentitySchema.safeParse({
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });

    if (!identity.success) {
      return Promise.reject(
        nonRetryableError('Payment amount or currency is invalid'),
      );
    }

    return Promise.resolve({
      providerPaymentId: encodeFakeId(identity.data),
      redirectUrl: input.returnUrl,
      status: 'pending',
    });
  }

  refund(input: RefundInput): Promise<CreatedRefund> {
    const payment = decodeFakePaymentId(input.providerPaymentId);

    if (!payment) {
      return Promise.reject(nonRetryableError('Payment id is not recognised'));
    }
    if (paymentScenarioFor(payment.amountMinor).finalStatus !== 'succeeded') {
      return Promise.reject(nonRetryableError('Payment did not succeed'));
    }
    if (input.currency !== payment.currency) {
      return Promise.reject(nonRetryableError('Refund currency differs'));
    }
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0 ||
      input.amountMinor > payment.amountMinor
    ) {
      return Promise.reject(nonRetryableError('Refund amount is out of range'));
    }

    return Promise.resolve({
      providerRefundId: encodeFakeId({
        reference: input.reference,
        providerPaymentId: input.providerPaymentId,
        amountMinor: input.amountMinor,
        currency: input.currency,
      }),
      status: refundScenarioFor(input.amountMinor).finalStatus,
    });
  }

  getStatus(query: StatusQuery): Promise<ResourceStatus | null> {
    return Promise.resolve(
      query.resource === 'payment'
        ? paymentStatusOf(query.providerPaymentId)
        : refundStatusOf(query),
    );
  }

  verifyWebhook(request: WebhookRequest): Promise<boolean> {
    const signature = request.headers[SIGNATURE_HEADER];
    if (typeof signature !== 'string') return Promise.resolve(false);

    // Compared as text: decoding as hex would silently drop invalid characters.
    const receivedSignature = Buffer.from(signature);
    const expectedSignature = Buffer.from(this.signatureOf(request.rawBody));

    return Promise.resolve(
      receivedSignature.length === expectedSignature.length &&
        timingSafeEqual(receivedSignature, expectedSignature),
    );
  }

  parseWebhook(request: WebhookRequest): ProviderEvents {
    const wireBody = fakeWireBodySchema.safeParse(
      parseJsonOrNull(request.rawBody),
    );

    if (!wireBody.success) {
      return [
        {
          type: 'unknown',
          rawType: null,
          dedupKey: dedupKeyFromBody(request.rawBody),
          occurredAt: null,
        },
      ];
    }

    const { eventId, occurredAt, events } = wireBody.data;
    const [firstEvent, ...otherEvents] = events.map((wireEvent) =>
      toProviderEvent(wireEvent, { dedupKey: eventId, occurredAt }),
    );

    return [firstEvent, ...otherEvents];
  }

  buildPaymentWebhooks(
    providerPaymentId: string,
    startedAt: Date,
  ): WebhookRequest[] {
    const payment = decodeFakePaymentId(providerPaymentId);
    if (!payment) throw nonRetryableError('Payment id is not recognised');

    return this.buildScenarioWebhooks(
      providerPaymentId,
      paymentScenarioFor(payment.amountMinor).eventTypes,
      startedAt,
      (type) => ({
        type,
        reference: payment.reference,
        providerPaymentId,
        providerSubscriptionId: null,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        failureReason: failureReasonOf(type),
      }),
    );
  }

  buildRefundWebhooks(
    providerRefundId: string,
    startedAt: Date,
  ): WebhookRequest[] {
    const refund = decodeFakeRefundId(providerRefundId);
    const payment = refund && decodeFakePaymentId(refund.providerPaymentId);
    if (!refund || !payment) {
      throw nonRetryableError('Refund id is not recognised');
    }

    return this.buildScenarioWebhooks(
      providerRefundId,
      refundScenarioFor(refund.amountMinor).eventTypes,
      startedAt,
      (type) => ({
        type,
        providerPaymentId: refund.providerPaymentId,
        reference: payment.reference,
        refundReference: refund.reference,
        providerRefundId,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
      }),
    );
  }

  buildWebhook(wireBody: FakeWireBody): WebhookRequest {
    return this.signRawBody(Buffer.from(JSON.stringify(wireBody)));
  }

  signRawBody(rawBody: Buffer): WebhookRequest {
    return {
      rawBody,
      headers: { [SIGNATURE_HEADER]: this.signatureOf(rawBody) },
    };
  }

  private buildScenarioWebhooks<EventType extends string>(
    resourceId: string,
    eventTypes: readonly EventType[],
    startedAt: Date,
    wireEventOf: (type: EventType) => unknown,
  ): WebhookRequest[] {
    return eventTypes.map((type, stepIndex) =>
      this.buildWebhook({
        eventId: eventIdOf(resourceId, type, stepIndex),
        occurredAt: new Date(
          startedAt.getTime() + stepIndex * STEP_INTERVAL_MS,
        ).toISOString(),
        events: [wireEventOf(type)],
      }),
    );
  }

  private signatureOf(rawBody: Buffer): string {
    return createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
  }
}
