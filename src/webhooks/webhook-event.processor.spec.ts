import { Logger } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';

import {
  PaymentMismatchError,
  PaymentNotFoundError,
  type PaymentsService,
} from '@/payments/payments.service';
import { FakeProvider } from '@/providers/fake/fake.provider';
import type { ProviderRegistry } from '@/providers/provider.registry';
import {
  RefundEventInvalidError,
  RefundPaymentNotFoundError,
  type RefundsService,
} from '@/refunds/refunds.service';

import { MAX_ATTEMPTS, WebhookEventProcessor } from './webhook-event.processor';
import type {
  ClaimedWebhookEvent,
  StoredDelivery,
} from './webhooks.repository';

const WEBHOOK_EVENT_ID = 'webhook-event-1';
const LEAK_MARKER = 'LEAKMARKER';

const paymentEventWith = (overrides: Record<string, unknown> = {}) => ({
  type: 'payment.failed',
  purpose: 'one_off',
  reference: 'reference-1',
  providerPaymentId: 'provider-payment-1',
  providerSubscriptionId: null,
  amountMinor: 1000,
  currency: 'USD',
  failureReason: 'card_declined',
  ...overrides,
});

const refundEventWith = (overrides: Record<string, unknown> = {}) => ({
  type: 'refund.failed',
  providerPaymentId: 'provider-payment-1',
  reference: 'reference-1',
  refundReference: 'refund-reference-1',
  providerRefundId: 'provider-refund-1',
  amountMinor: 400,
  currency: 'USD',
  ...overrides,
});

const subscriptionEvent = {
  type: 'subscription.canceled',
  reference: null,
  providerSubscriptionId: 'subscription-1',
  providerStatus: 'canceled',
  currentPeriodEnd: null,
};

const claimedWith = (
  overrides: Partial<ClaimedWebhookEvent> = {},
): ClaimedWebhookEvent => ({
  id: WEBHOOK_EVENT_ID,
  provider: 'fake',
  replayOf: null,
  attempts: 1,
  ...overrides,
});

const queryErrorWithCode = (code: string): DrizzleQueryError =>
  new DrizzleQueryError(
    `update ${LEAK_MARKER}`,
    [LEAK_MARKER],
    Object.assign(new Error(LEAK_MARKER), { code }),
  );

const notFoundError = (): PaymentNotFoundError =>
  new PaymentNotFoundError({
    reference: null,
    provider: 'fake',
    providerPaymentId: 'provider-payment-1',
  });

describe('WebhookEventProcessor', () => {
  const fakeProvider = new FakeProvider(Buffer.alloc(32, 1));
  let ingestPayment: jest.Mock;
  let ingestRefund: jest.Mock;
  let warn: jest.SpyInstance;
  let processor: WebhookEventProcessor;

  const deliveryWith = (events: readonly unknown[]): StoredDelivery => ({
    rawBody: fakeProvider.buildWebhook({
      eventId: 'event-1',
      occurredAt: null,
      events,
    }).rawBody,
    headers: {},
  });

  const processEvents = (events: readonly unknown[], claimed = claimedWith()) =>
    processor.process(claimed, deliveryWith(events));

  const processorWith = (registry: Partial<ProviderRegistry>) =>
    new WebhookEventProcessor(
      registry as ProviderRegistry,
      { ingestPayment } as unknown as PaymentsService,
      { ingestRefund } as unknown as RefundsService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ingestPayment = jest.fn().mockResolvedValue({
      payment: { id: 'payment-1' },
      outcome: 'applied',
    });
    ingestRefund = jest.fn().mockResolvedValue({
      refund: { id: 'refund-1', status: 'failed' },
      refundOutcome: 'applied',
      payment: { id: 'payment-1' },
      paymentOutcome: 'unchanged',
      refundedTotalMinor: 0,
    });
    processor = processorWith({
      find: () => fakeProvider,
      refundIdentityOf: () => 'reference',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('payment events', () => {
    it('passes the event facts, its reason and the inbox id to the ingest', async () => {
      await processEvents([paymentEventWith()]);

      expect(ingestPayment).toHaveBeenCalledWith({
        reference: 'reference-1',
        provider: 'fake',
        providerPaymentId: 'provider-payment-1',
        status: 'failed',
        amountMinor: 1000,
        currency: 'USD',
        purpose: 'one_off',
        reason: 'card_declined',
        webhookEventId: WEBHOOK_EVENT_ID,
      });
    });

    it.each(['one_off', 'subscription_initial', 'subscription_renewal'])(
      'passes the purpose %s as stated, whatever providerSubscriptionId says',
      async (purpose) => {
        await processEvents([
          paymentEventWith({ purpose, providerSubscriptionId: 'sub-1' }),
          paymentEventWith({ purpose, providerSubscriptionId: null }),
        ]);

        expect(
          ingestPayment.mock.calls.map(
            ([input]: [{ purpose: string }]) => input.purpose,
          ),
        ).toEqual([purpose, purpose]);
      },
    );

    it.each([
      ['payment.pending', 'pending'],
      ['payment.attempt_failed', 'pending'],
      ['payment.succeeded', 'succeeded'],
      ['payment.expired', 'expired'],
    ])('maps %s to %s with the type as the reason', async (type, status) => {
      await processEvents([paymentEventWith({ type, failureReason: null })]);

      expect(ingestPayment).toHaveBeenCalledWith(
        expect.objectContaining({ status, reason: type }),
      );
    });

    it('strips control characters from the reason and caps it at 200', async () => {
      await processEvents([
        paymentEventWith({ failureReason: `bad\u0000${'r'.repeat(300)}` }),
      ]);

      expect(ingestPayment).toHaveBeenCalledWith(
        expect.objectContaining({ reason: `bad${'r'.repeat(197)}` }),
      );
    });
  });

  describe('refund events', () => {
    it('takes the refund identity from the registry and the status from the type', async () => {
      await processEvents([refundEventWith()]);

      expect(ingestRefund).toHaveBeenCalledWith({
        reference: 'reference-1',
        provider: 'fake',
        providerPaymentId: 'provider-payment-1',
        refundReference: 'refund-reference-1',
        providerRefundId: 'provider-refund-1',
        refundIdentity: 'reference',
        status: 'failed',
        amountMinor: 400,
        currency: 'USD',
        reason: 'refund.failed',
        webhookEventId: WEBHOOK_EVENT_ID,
      });
    });

    it('keeps a refund conflict as the note of a processed row', async () => {
      ingestRefund.mockResolvedValue({
        refund: { id: 'refund-1', status: 'succeeded' },
        refundOutcome: 'conflict',
        payment: { id: 'payment-1' },
        paymentOutcome: 'unchanged',
        refundedTotalMinor: 400,
      });

      await expect(processEvents([refundEventWith()])).resolves.toEqual({
        status: 'processed',
        lastError: 'Refund refund-1 conflict: succeeded -> failed',
        paymentIds: ['payment-1'],
      });
    });
  });

  describe('outcomes', () => {
    it('marks a handled delivery processed with its payment ids and no error', async () => {
      await expect(
        processEvents([paymentEventWith(), refundEventWith()]),
      ).resolves.toEqual({
        status: 'processed',
        lastError: null,
        paymentIds: ['payment-1'],
      });
    });

    it('ignores a delivery of only unknown and subscription events', async () => {
      await expect(
        processEvents([subscriptionEvent, { type: 'some.new.type' }]),
      ).resolves.toEqual({
        status: 'ignored',
        lastError: null,
        paymentIds: [],
      });
      expect(ingestPayment).not.toHaveBeenCalled();
      expect(ingestRefund).not.toHaveBeenCalled();
    });

    it.each([
      [1, 30],
      [2, 120],
      [3, 600],
      [4, 3600],
      [5, 21600],
    ])(
      'retries attempt %i after %i s while the payment is not found',
      async (attempts, retryDelaySeconds) => {
        ingestPayment.mockRejectedValue(notFoundError());

        await expect(
          processEvents([paymentEventWith()], claimedWith({ attempts })),
        ).resolves.toEqual({
          status: 'received',
          retryDelaySeconds,
          lastError:
            'No payment for reference null or provider ref provider-payment-1 yet',
          paymentIds: [],
        });
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('retries a refund before its payment like a payment not found', async () => {
      ingestRefund.mockRejectedValue(
        new RefundPaymentNotFoundError('provider-payment-1'),
      );

      await expect(processEvents([refundEventWith()])).resolves.toMatchObject({
        status: 'received',
        retryDelaySeconds: 30,
        lastError: 'No payment for provider ref provider-payment-1 yet',
      });
    });

    it('fails a retryable delivery at the last attempt with one warn', async () => {
      ingestPayment.mockRejectedValue(notFoundError());

      await expect(
        processEvents(
          [paymentEventWith()],
          claimedWith({ attempts: MAX_ATTEMPTS }),
        ),
      ).resolves.toMatchObject({ status: 'failed' });
      expect(MAX_ATTEMPTS).toBe(6);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('fails a row claimed past the last attempt without parsing it', async () => {
      const parseWebhook = jest.spyOn(fakeProvider, 'parseWebhook');

      await expect(
        processEvents(
          [paymentEventWith()],
          claimedWith({ attempts: MAX_ATTEMPTS + 1 }),
        ),
      ).resolves.toMatchObject({ status: 'failed', paymentIds: [] });
      expect(parseWebhook).not.toHaveBeenCalled();
      expect(ingestPayment).not.toHaveBeenCalled();
    });

    it('fails a row of an unregistered provider', async () => {
      processor = processorWith({ find: () => null });

      await expect(processEvents([paymentEventWith()])).resolves.toEqual({
        status: 'failed',
        lastError: 'Provider is not registered',
        paymentIds: [],
      });
    });

    it('fails a row with no stored body', async () => {
      await expect(processor.process(claimedWith(), null)).resolves.toEqual({
        status: 'failed',
        lastError: 'Delivery has no body',
        paymentIds: [],
      });
    });

    it('retries when the provider cannot parse the stored body', async () => {
      jest.spyOn(fakeProvider, 'parseWebhook').mockImplementation(() => {
        throw new TypeError(LEAK_MARKER);
      });

      await expect(processEvents([paymentEventWith()])).resolves.toEqual({
        status: 'received',
        retryDelaySeconds: 30,
        lastError: 'TypeError',
        paymentIds: [],
      });
    });
  });

  describe('classification', () => {
    it.each([
      [
        'a payment mismatch',
        new PaymentMismatchError(
          { id: 'payment-1', amountMinor: 1000, currency: 'USD' },
          { amountMinor: 2000, currency: 'USD' },
        ),
      ],
      ['an invalid refund event', new RefundEventInvalidError('amountMinor')],
      ['a NUL in a text value', queryErrorWithCode('22021')],
      ['an invalid uuid', queryErrorWithCode('22P02')],
      ['a check violation', queryErrorWithCode('23514')],
    ])('fails at once on %s', async (_case, error) => {
      ingestPayment.mockRejectedValue(error);

      await expect(processEvents([paymentEventWith()])).resolves.toMatchObject({
        status: 'failed',
      });
    });

    it.each([
      ['a serialization failure', queryErrorWithCode('40001')],
      ['a statement timeout', queryErrorWithCode('57014')],
      ['a lost connection', queryErrorWithCode('08006')],
      ['a unique violation', queryErrorWithCode('23505')],
      ['an unknown bug', new TypeError(LEAK_MARKER)],
    ])('retries on %s', async (_case, error) => {
      ingestPayment.mockRejectedValue(error);

      await expect(processEvents([paymentEventWith()])).resolves.toMatchObject({
        status: 'received',
        retryDelaySeconds: 30,
      });
    });

    it('fails a delivery with a handled and a rejected event and keeps the payment id', async () => {
      ingestPayment
        .mockResolvedValueOnce({
          payment: { id: 'payment-1' },
          outcome: 'applied',
        })
        .mockRejectedValueOnce(queryErrorWithCode('22021'));

      await expect(
        processEvents([paymentEventWith(), paymentEventWith()]),
      ).resolves.toEqual({
        status: 'failed',
        lastError: 'DrizzleQueryError 22021',
        paymentIds: ['payment-1'],
      });
    });

    it('retries a delivery with a rejected and a retryable event, keeping the first error', async () => {
      ingestPayment
        .mockRejectedValueOnce(queryErrorWithCode('22021'))
        .mockRejectedValueOnce(notFoundError());

      await expect(
        processEvents([paymentEventWith(), paymentEventWith()]),
      ).resolves.toEqual({
        status: 'received',
        retryDelaySeconds: 30,
        lastError: 'DrizzleQueryError 22021',
        paymentIds: [],
      });
    });

    it('runs every event of a delivery after one fails', async () => {
      ingestPayment.mockRejectedValueOnce(notFoundError());

      await processEvents([paymentEventWith(), refundEventWith()]);

      expect(ingestRefund).toHaveBeenCalledTimes(1);
    });
  });

  describe('last_error', () => {
    it('stores only the class of an unexpected error and logs no message', async () => {
      ingestPayment.mockRejectedValue(
        new Error(`password=${LEAK_MARKER} postgres://user:${LEAK_MARKER}@db`),
      );

      const finish = await processEvents(
        [paymentEventWith()],
        claimedWith({ attempts: MAX_ATTEMPTS }),
      );

      expect(finish.lastError).toBe('Error');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(LEAK_MARKER);
    });

    it('stores the class and the pg code of a query error, not its params', async () => {
      ingestPayment.mockRejectedValue(queryErrorWithCode('40001'));

      const finish = await processEvents([paymentEventWith()]);

      expect(finish.lastError).toBe('DrizzleQueryError 40001');
    });

    it('caps a domain message at 1000 characters without control characters', async () => {
      ingestPayment.mockRejectedValue(
        new RefundEventInvalidError(`\u0000\u0007${'x'.repeat(1500)}`),
      );

      const finish = await processEvents([paymentEventWith()]);

      expect(finish.lastError).toBe(
        `Refund event is invalid: ${'x'.repeat(1500)}`.slice(0, 1000),
      );
      expect(finish.lastError).toHaveLength(1000);
    });
  });
});
