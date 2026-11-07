import { ProviderError, type WebhookRequest } from '../payment-provider.port';
import type { ProviderPaymentEvent } from '../provider-events';

import { FakeProvider } from './fake.provider';

const SECRET = Buffer.alloc(32, 1);
const OTHER_SECRET = Buffer.alloc(32, 2);
const STARTED_AT = new Date('2026-01-01T00:00:00.000Z');
const SIGNATURE_HEADER = 'x-fake-signature';

const paymentInputWith = (amountMinor: number, currency = 'USD') => ({
  reference: 'payment-reference',
  amountMinor,
  currency,
  description: 'test payment',
  returnUrl: 'https://example.test/return',
  webhookUrl: 'https://example.test/webhook',
});

const wirePaymentEvent = {
  type: 'payment.succeeded',
  purpose: 'one_off',
  reference: 'payment-reference',
  providerPaymentId: 'provider-1',
  providerSubscriptionId: null,
  amountMinor: 1000,
  currency: 'USD',
  failureReason: null,
};

const wireSubscriptionEvent = {
  type: 'subscription.canceled',
  reference: null,
  providerSubscriptionId: 'subscription-1',
  providerStatus: 'canceled',
  currentPeriodEnd: null,
};

const wireBodyWith = (events: readonly unknown[]) => ({
  eventId: 'event-1',
  occurredAt: STARTED_AT.toISOString(),
  events,
});

const withHeader = (
  request: WebhookRequest,
  signature: string | readonly string[] | undefined,
): WebhookRequest => ({
  rawBody: request.rawBody,
  headers: { [SIGNATURE_HEADER]: signature },
});

describe('FakeProvider', () => {
  const fakeProvider = new FakeProvider(SECRET);

  const eventTypesOf = (webhooks: WebhookRequest[]): string[] =>
    webhooks.flatMap((webhook) =>
      fakeProvider.parseWebhook(webhook).map(({ type }) => type),
    );

  const createdPaymentId = async (amountMinor: number): Promise<string> => {
    const { providerPaymentId } = await fakeProvider.createPayment(
      paymentInputWith(amountMinor),
    );

    return providerPaymentId;
  };

  it('declares no recurring, intervals or catalog, allows partial refunds and identifies a refund by the provider id', () => {
    expect(fakeProvider.capabilities).toEqual({
      recurring: 'none',
      intervals: [],
      partialRefund: true,
      catalog: false,
      refundIdentity: 'provider',
    });
  });

  it('declares its signature header as the only webhook header it needs', () => {
    expect(fakeProvider.webhookHeaders).toEqual(['x-fake-signature']);
  });

  it('rejects a payment amount that is not a safe integer', async () => {
    await expect(
      fakeProvider.createPayment(paymentInputWith(10.5)),
    ).rejects.toMatchObject({
      providerCode: 'fake',
      kind: 'rejected',
      isRetryable: false,
    });
  });

  describe('verifyWebhook', () => {
    const signedRequest = fakeProvider.buildWebhook(
      wireBodyWith([wirePaymentEvent]),
    );
    const signature = signedRequest.headers[SIGNATURE_HEADER] as string;

    it('accepts its own signed request', async () => {
      await expect(fakeProvider.verifyWebhook(signedRequest)).resolves.toBe(
        true,
      );
    });

    it('rejects a flipped body byte', async () => {
      const flippedBody = Buffer.from(signedRequest.rawBody);
      flippedBody[0] ^= 1;

      await expect(
        fakeProvider.verifyWebhook({ ...signedRequest, rawBody: flippedBody }),
      ).resolves.toBe(false);
    });

    it.each([
      ['a missing header', undefined],
      ['an array-valued header', [signature]],
      ['a truncated signature', signature.slice(0, -1)],
      ['a same-length non-hex signature', 'z'.repeat(signature.length)],
    ])('rejects %s', async (_case, headerValue) => {
      await expect(
        fakeProvider.verifyWebhook(withHeader(signedRequest, headerValue)),
      ).resolves.toBe(false);
    });

    it('rejects a signature made with another secret', async () => {
      const otherProvider = new FakeProvider(OTHER_SECRET);

      await expect(
        fakeProvider.verifyWebhook(
          otherProvider.signRawBody(signedRequest.rawBody),
        ),
      ).resolves.toBe(false);
    });
  });

  it('produces identical bytes from two instances with one secret', async () => {
    const otherProvider = new FakeProvider(SECRET);
    const input = paymentInputWith(1002);

    const created = await fakeProvider.createPayment(input);
    const otherCreated = await otherProvider.createPayment(input);

    expect(otherCreated).toEqual(created);
    expect(
      otherProvider.buildPaymentWebhooks(
        otherCreated.providerPaymentId,
        STARTED_AT,
      ),
    ).toEqual(
      fakeProvider.buildPaymentWebhooks(created.providerPaymentId, STARTED_AT),
    );
  });

  it('spaces occurredAt one second per step from startedAt', async () => {
    const providerPaymentId = await createdPaymentId(1000);

    const occurredAts = fakeProvider
      .buildPaymentWebhooks(providerPaymentId, STARTED_AT)
      .map((webhook) => fakeProvider.parseWebhook(webhook)[0].occurredAt);

    expect(occurredAts).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ]);
  });

  describe('payment scenarios', () => {
    it.each([
      [1000, ['payment.pending', 'payment.succeeded'], 'succeeded'],
      [1001, ['payment.pending', 'payment.failed'], 'failed'],
      [
        1002,
        ['payment.pending', 'payment.attempt_failed', 'payment.succeeded'],
        'succeeded',
      ],
      [
        1003,
        ['payment.pending', 'payment.attempt_failed', 'payment.failed'],
        'failed',
      ],
      [1004, ['payment.pending', 'payment.expired'], 'expired'],
      [1005, ['payment.pending'], 'pending'],
    ])(
      'amount %i sends %j and ends %s',
      async (amountMinor, eventTypes, finalStatus) => {
        const providerPaymentId = await createdPaymentId(amountMinor);

        const webhooks = fakeProvider.buildPaymentWebhooks(
          providerPaymentId,
          STARTED_AT,
        );

        expect(eventTypesOf(webhooks)).toEqual(eventTypes);
        expect(
          webhooks.flatMap((webhook) =>
            fakeProvider
              .parseWebhook(webhook)
              .map((event) => ('purpose' in event ? event.purpose : null)),
          ),
        ).toEqual(eventTypes.map(() => 'one_off'));
        await expect(
          fakeProvider.getStatus({ resource: 'payment', providerPaymentId }),
        ).resolves.toEqual({
          resource: 'payment',
          providerPaymentId,
          status: finalStatus,
          amountMinor,
          currency: 'USD',
        });
      },
    );
  });

  describe('parseWebhook', () => {
    it.each([
      ['non-JSON', 'not json'],
      ['an empty object', '{}'],
      [
        'an empty event list',
        JSON.stringify({ eventId: 'event-1', occurredAt: null, events: [] }),
      ],
    ])('returns one unknown event with a body hash for %s', (_case, body) => {
      const rawBody = Buffer.from(body);
      const request = fakeProvider.signRawBody(rawBody);

      const events = fakeProvider.parseWebhook(request);

      expect(events).toEqual([
        {
          type: 'unknown',
          rawType: null,
          dedupKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as string,
          occurredAt: null,
        },
      ]);
      expect(fakeProvider.parseWebhook(request)[0].dedupKey).toBe(
        events[0].dedupKey,
      );
    });

    it.each([
      ['a fractional amount', { amountMinor: 10.5 }],
      ['an unsafe amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
      ['a lowercase currency', { currency: 'usd' }],
    ])('turns an item with %s into unknown', (_case, badField) => {
      const [event] = fakeProvider.parseWebhook(
        fakeProvider.buildWebhook(
          wireBodyWith([{ ...wirePaymentEvent, ...badField }]),
        ),
      );

      expect(event).toMatchObject({
        type: 'unknown',
        rawType: 'payment.succeeded',
        dedupKey: 'event-1',
      });
    });

    it.each([
      ['an empty provider refund id', { providerRefundId: '' }],
      ['a zero amount', { amountMinor: 0 }],
    ])('turns a refund item with %s into unknown', (_case, badField) => {
      const [event] = fakeProvider.parseWebhook(
        fakeProvider.buildWebhook(
          wireBodyWith([
            {
              type: 'refund.succeeded',
              providerPaymentId: 'provider-1',
              reference: null,
              refundReference: 'refund-1',
              providerRefundId: 'provider-refund-1',
              amountMinor: 100,
              currency: 'USD',
              ...badField,
            },
          ]),
        ),
      );

      expect(event).toMatchObject({
        type: 'unknown',
        rawType: 'refund.succeeded',
      });
    });

    it('turns a payment item without purpose into unknown', () => {
      const { purpose: _purpose, ...eventWithoutPurpose } = wirePaymentEvent;

      const [event] = fakeProvider.parseWebhook(
        fakeProvider.buildWebhook(wireBodyWith([eventWithoutPurpose])),
      );

      expect(event).toMatchObject({
        type: 'unknown',
        rawType: 'payment.succeeded',
      });
    });

    it.each(['subscription_initial', 'subscription_renewal'])(
      'keeps the purpose %s a signed payment item states',
      (purpose) => {
        const [event] = fakeProvider.parseWebhook(
          fakeProvider.buildWebhook(
            wireBodyWith([{ ...wirePaymentEvent, purpose }]),
          ),
        );

        expect(event).toMatchObject({ type: 'payment.succeeded', purpose });
      },
    );

    it('needs a purpose on a payment event at compile time', () => {
      // @ts-expect-error purpose is required: no adapter may leave it to inference
      const eventWithoutPurpose: ProviderPaymentEvent = {
        type: 'payment.succeeded',
        dedupKey: 'event-1',
        occurredAt: null,
        reference: null,
        providerPaymentId: 'provider-1',
        providerSubscriptionId: 'subscription-1',
        amountMinor: 1000,
        currency: 'USD',
        failureReason: null,
      };

      expect(eventWithoutPurpose).not.toHaveProperty('purpose');
    });

    it('turns an item with no type into unknown with a null rawType', () => {
      const [event] = fakeProvider.parseWebhook(
        fakeProvider.buildWebhook(wireBodyWith([42])),
      );

      expect(event).toMatchObject({ type: 'unknown', rawType: null });
    });

    it('parses a mixed batch item by item under one dedup key', () => {
      const events = fakeProvider.parseWebhook(
        fakeProvider.buildWebhook(
          wireBodyWith([
            wirePaymentEvent,
            wireSubscriptionEvent,
            { type: 'some.new.type' },
          ]),
        ),
      );

      expect(events).toMatchObject([
        { type: 'payment.succeeded', providerPaymentId: 'provider-1' },
        { type: 'subscription.canceled', providerStatus: 'canceled' },
        { type: 'unknown', rawType: 'some.new.type' },
      ]);
      expect(new Set(events.map(({ dedupKey }) => dedupKey))).toEqual(
        new Set(['event-1']),
      );
    });

    it('gives a re-sent delivery the same key and each step its own', async () => {
      const providerPaymentId = await createdPaymentId(1002);
      const keysOf = (): string[] =>
        fakeProvider
          .buildPaymentWebhooks(providerPaymentId, STARTED_AT)
          .map((webhook) => fakeProvider.parseWebhook(webhook)[0].dedupKey);

      const keys = keysOf();

      expect(keysOf()).toEqual(keys);
      expect(new Set(keys).size).toBe(3);
    });
  });

  describe('refund', () => {
    const refundInputWith = (
      providerPaymentId: string,
      amountMinor: number,
    ) => ({
      reference: 'refund-reference',
      providerPaymentId,
      amountMinor,
      currency: 'USD',
    });

    it.each([
      [400, 'succeeded', ['refund.pending', 'refund.succeeded']],
      [401, 'failed', ['refund.pending', 'refund.failed']],
      [405, 'pending', ['refund.pending']],
    ])(
      'with amount %i ends %s and getStatus agrees on a fresh instance',
      async (amountMinor, status, eventTypes) => {
        const providerPaymentId = await createdPaymentId(1000);
        const input = refundInputWith(providerPaymentId, amountMinor);

        const created = await fakeProvider.refund(input);
        const freshProvider = new FakeProvider(SECRET);

        expect(created.status).toBe(status);
        await expect(freshProvider.refund(input)).resolves.toEqual(created);
        await expect(
          freshProvider.getStatus({
            resource: 'refund',
            providerPaymentId,
            providerRefundId: created.providerRefundId,
            reference: input.reference,
          }),
        ).resolves.toEqual({
          resource: 'refund',
          providerRefundId: created.providerRefundId,
          status,
          amountMinor,
          currency: 'USD',
        });
        expect(
          eventTypesOf(
            fakeProvider.buildRefundWebhooks(
              created.providerRefundId as string,
              STARTED_AT,
            ),
          ),
        ).toEqual(eventTypes);
      },
    );

    it('carries both references and the ids on a refund webhook', async () => {
      const providerPaymentId = await createdPaymentId(1000);
      const { providerRefundId } = await fakeProvider.refund(
        refundInputWith(providerPaymentId, 400),
      );

      const [webhook] = fakeProvider.buildRefundWebhooks(
        providerRefundId as string,
        STARTED_AT,
      );

      expect(fakeProvider.parseWebhook(webhook)[0]).toMatchObject({
        type: 'refund.pending',
        providerPaymentId,
        reference: 'payment-reference',
        refundReference: 'refund-reference',
        providerRefundId,
        amountMinor: 400,
      });
    });

    it.each([
      ['a uuid reference', '7f3c1a52-8d4e-4b6a-9c21-0e5d7a9b3f10'],
      ['a non-uuid reference', 'attempt-1'],
    ])(
      'puts the provider refund id on every event with %s',
      async (_case, reference) => {
        const providerPaymentId = await createdPaymentId(1000);
        const { providerRefundId } = await fakeProvider.refund({
          ...refundInputWith(providerPaymentId, 400),
          reference,
        });

        const events = fakeProvider
          .buildRefundWebhooks(providerRefundId as string, STARTED_AT)
          .flatMap((webhook) => [...fakeProvider.parseWebhook(webhook)]);

        expect(events).toHaveLength(2);
        events.forEach((event) => {
          expect(event).toMatchObject({ providerRefundId });
        });
        expect(providerRefundId).not.toBeNull();
      },
    );

    it.each([
      ['an undecodable id', 'not-a-fake-id', 1000, 400, 'USD'],
      ['a failed-scenario payment', null, 1001, 400, 'USD'],
      ['an expired-scenario payment', null, 1004, 400, 'USD'],
      ['a still-pending payment', null, 1005, 400, 'USD'],
      ['a currency mismatch', null, 1000, 400, 'EUR'],
      ['an amount above the payment', null, 1000, 1001, 'USD'],
      ['a zero amount', null, 1000, 0, 'USD'],
      ['a fractional amount', null, 1000, 400.5, 'USD'],
    ])(
      'rejects as non-retryable for %s',
      async (_case, fixedId, paymentAmount, refundAmount, currency) => {
        const providerPaymentId =
          fixedId ?? (await createdPaymentId(paymentAmount));

        const error: unknown = await fakeProvider
          .refund({
            ...refundInputWith(providerPaymentId, refundAmount),
            currency,
          })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({
          providerCode: 'fake',
          kind: 'rejected',
          isRetryable: false,
        });
      },
    );

    it('allows a refund of the full payment amount', async () => {
      const providerPaymentId = await createdPaymentId(1000);

      await expect(
        fakeProvider.refund(refundInputWith(providerPaymentId, 1000)),
      ).resolves.toMatchObject({ status: 'succeeded' });
    });
  });

  describe('getStatus', () => {
    it('returns null for an undecodable payment id', async () => {
      await expect(
        fakeProvider.getStatus({
          resource: 'payment',
          providerPaymentId: 'not-a-fake-id',
        }),
      ).resolves.toBeNull();
    });

    it('returns null for an undecodable refund id', async () => {
      await expect(
        fakeProvider.getStatus({
          resource: 'refund',
          providerPaymentId: 'provider-1',
          providerRefundId: 'not-a-fake-id',
          reference: 'refund-reference',
        }),
      ).resolves.toBeNull();
    });

    it('returns null for a refund with no provider id', async () => {
      await expect(
        fakeProvider.getStatus({
          resource: 'refund',
          providerPaymentId: 'provider-1',
          providerRefundId: null,
          reference: 'refund-reference',
        }),
      ).resolves.toBeNull();
    });

    it('returns null when a refund id belongs to another payment or reference', async () => {
      const providerPaymentId = await createdPaymentId(1000);
      const otherPaymentId = await createdPaymentId(2000);
      const { providerRefundId } = await fakeProvider.refund({
        reference: 'refund-reference',
        providerPaymentId,
        amountMinor: 400,
        currency: 'USD',
      });

      await expect(
        fakeProvider.getStatus({
          resource: 'refund',
          providerPaymentId: otherPaymentId,
          providerRefundId,
          reference: 'refund-reference',
        }),
      ).resolves.toBeNull();
      await expect(
        fakeProvider.getStatus({
          resource: 'refund',
          providerPaymentId,
          providerRefundId,
          reference: 'other-reference',
        }),
      ).resolves.toBeNull();
    });

    it('does not read a refund id as a payment id', async () => {
      const providerPaymentId = await createdPaymentId(1000);
      const { providerRefundId } = await fakeProvider.refund({
        reference: 'refund-reference',
        providerPaymentId,
        amountMinor: 400,
        currency: 'USD',
      });

      await expect(
        fakeProvider.getStatus({
          resource: 'payment',
          providerPaymentId: providerRefundId as string,
        }),
      ).resolves.toBeNull();
    });
  });

  describe('reference', () => {
    it.each(['attempt-1', '', '  spaced / "quoted" кирилиця '])(
      'round-trips the opaque value %j unchanged',
      async (reference) => {
        const { providerPaymentId } = await fakeProvider.createPayment({
          ...paymentInputWith(1000),
          reference,
        });

        const events = fakeProvider
          .buildPaymentWebhooks(providerPaymentId, STARTED_AT)
          .flatMap((webhook) => [...fakeProvider.parseWebhook(webhook)]);

        expect(events).toHaveLength(2);
        events.forEach((event) => {
          expect(event).toMatchObject({ reference });
        });
        await expect(
          fakeProvider.getStatus({ resource: 'payment', providerPaymentId }),
        ).resolves.toMatchObject({ status: 'succeeded' });

        const { providerRefundId, status } = await fakeProvider.refund({
          reference,
          providerPaymentId,
          amountMinor: 400,
          currency: 'USD',
        });
        const [refundWebhook] = fakeProvider.buildRefundWebhooks(
          providerRefundId as string,
          STARTED_AT,
        );

        expect(status).toBe('succeeded');
        expect(fakeProvider.parseWebhook(refundWebhook)[0]).toMatchObject({
          reference,
          refundReference: reference,
        });
        await expect(
          fakeProvider.getStatus({
            resource: 'refund',
            providerPaymentId,
            providerRefundId,
            reference,
          }),
        ).resolves.toMatchObject({ status: 'succeeded' });
      },
    );
  });
});
