import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  FakeCredentials,
  RedactedSecret,
} from '@/provider-accounts/provider-credentials';

import {
  ProviderError,
  type CreatedPayment,
  type CreatedRefund,
  type CreatePaymentInput,
  type PaymentProvider,
  type ProviderCapabilities,
  type ProviderErrorKind,
  type ProviderRefundRecord,
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
  callFailureFor,
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
} from './fake-wire-format';

type EventContext = { dedupKey: string; occurredAt: string | null };

const SIGNATURE_HEADER = 'x-fake-signature';
const STEP_INTERVAL_MS = 1000;
const FAKE_DECLINE_REASON = 'fake_declined';

const FAKE_CAPABILITIES: ProviderCapabilities = {
  recurring: 'none',
  intervals: [],
  partialRefund: true,
  catalog: false,
  refundIdentity: 'provider',
};

const rejectedError = (message: string): ProviderError =>
  new ProviderError(message, { providerCode: 'fake', kind: 'rejected' });

const amountFailureError = (kind: ProviderErrorKind): ProviderError =>
  new ProviderError(`Fake ${kind} failure chosen by the amount`, {
    providerCode: 'fake',
    kind,
  });

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

const signatureOf = (secret: RedactedSecret, rawBody: Buffer): string =>
  createHmac('sha256', secret.reveal()).update(rawBody).digest('hex');

// Compared as text: decoding as hex would silently drop invalid characters.
const isSameSignature = (received: string, expected: string): boolean => {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);

  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
};

export class FakeProvider implements PaymentProvider<FakeCredentials> {
  readonly code = 'fake';
  readonly capabilities = FAKE_CAPABILITIES;
  readonly webhookHeaders = [SIGNATURE_HEADER];

  createPayment(
    _credentials: FakeCredentials,
    input: CreatePaymentInput,
  ): Promise<CreatedPayment> {
    const identity = fakePaymentIdentitySchema.safeParse({
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });

    if (!identity.success) {
      return Promise.reject(
        rejectedError('Payment amount or currency is invalid'),
      );
    }

    const failureKind = callFailureFor(identity.data.amountMinor);
    if (failureKind) return Promise.reject(amountFailureError(failureKind));

    return Promise.resolve({
      providerPaymentId: encodeFakeId(identity.data),
      redirectUrl: input.returnUrl,
      status: 'pending',
    });
  }

  refund(
    _credentials: FakeCredentials,
    input: RefundInput,
  ): Promise<CreatedRefund> {
    const payment = decodeFakePaymentId(input.providerPaymentId);

    if (!payment) {
      return Promise.reject(rejectedError('Payment id is not recognised'));
    }
    if (paymentScenarioFor(payment.amountMinor).finalStatus !== 'succeeded') {
      return Promise.reject(rejectedError('Payment did not succeed'));
    }
    if (input.currency !== payment.currency) {
      return Promise.reject(rejectedError('Refund currency differs'));
    }
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0 ||
      input.amountMinor > payment.amountMinor
    ) {
      return Promise.reject(rejectedError('Refund amount is out of range'));
    }

    const failureKind = callFailureFor(input.amountMinor);
    if (failureKind) return Promise.reject(amountFailureError(failureKind));

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

  getStatus(
    _credentials: FakeCredentials,
    query: StatusQuery,
  ): Promise<ResourceStatus | null> {
    return Promise.resolve(
      query.resource === 'payment'
        ? paymentStatusOf(query.providerPaymentId)
        : refundStatusOf(query),
    );
  }

  // Keeps no data, so it knows no refund beyond what its ids encode.
  listRefunds(): Promise<readonly ProviderRefundRecord[]> {
    return Promise.resolve([]);
  }

  verifyWebhook(
    credentials: FakeCredentials,
    request: WebhookRequest,
  ): Promise<boolean> {
    if (credentials.webhookSecrets.length === 0) {
      return Promise.reject(
        new ProviderError('fake webhook secret is not configured', {
          providerCode: 'fake',
          kind: 'misconfigured',
        }),
      );
    }

    const signature = request.headers[SIGNATURE_HEADER];
    if (typeof signature !== 'string') return Promise.resolve(false);

    return Promise.resolve(
      credentials.webhookSecrets.some((secret) =>
        isSameSignature(signature, signatureOf(secret, request.rawBody)),
      ),
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
    secret: RedactedSecret,
    providerPaymentId: string,
    startedAt: Date,
  ): WebhookRequest[] {
    const payment = decodeFakePaymentId(providerPaymentId);
    if (!payment) throw rejectedError('Payment id is not recognised');

    return this.buildScenarioWebhooks(
      secret,
      providerPaymentId,
      paymentScenarioFor(payment.amountMinor).eventTypes,
      startedAt,
      (type) => ({
        type,
        purpose: 'one_off',
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
    secret: RedactedSecret,
    providerRefundId: string,
    startedAt: Date,
  ): WebhookRequest[] {
    const refund = decodeFakeRefundId(providerRefundId);
    const payment = refund && decodeFakePaymentId(refund.providerPaymentId);
    if (!refund || !payment) {
      throw rejectedError('Refund id is not recognised');
    }

    return this.buildScenarioWebhooks(
      secret,
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

  buildWebhook(secret: RedactedSecret, wireBody: FakeWireBody): WebhookRequest {
    return this.signRawBody(secret, Buffer.from(JSON.stringify(wireBody)));
  }

  signRawBody(secret: RedactedSecret, rawBody: Buffer): WebhookRequest {
    return {
      rawBody,
      headers: { [SIGNATURE_HEADER]: signatureOf(secret, rawBody) },
    };
  }

  private buildScenarioWebhooks<EventType extends string>(
    secret: RedactedSecret,
    resourceId: string,
    eventTypes: readonly EventType[],
    startedAt: Date,
    wireEventOf: (type: EventType) => unknown,
  ): WebhookRequest[] {
    return eventTypes.map((type, stepIndex) =>
      this.buildWebhook(secret, {
        eventId: eventIdOf(resourceId, type, stepIndex),
        occurredAt: new Date(
          startedAt.getTime() + stepIndex * STEP_INTERVAL_MS,
        ).toISOString(),
        events: [wireEventOf(type)],
      }),
    );
  }
}
