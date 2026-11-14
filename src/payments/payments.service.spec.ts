import { Logger } from '@nestjs/common';

import type { DatabaseTransaction } from '@/database/drizzle';
import type { Payment } from '@/database/schemas/payments.schema';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import { SEED_FAKE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';
import type { ProviderPaymentStatus } from '@/providers/payment-provider.port';

import type { PaymentsRepository } from './payments.repository';
import {
  IngestRejectedError,
  PaymentEventInvalidError,
  PaymentMismatchError,
  PaymentNotFoundError,
  PaymentProviderRefMismatchError,
  PaymentProviderRefOwnedError,
  PaymentsService,
  type IngestPaymentInput,
} from './payments.service';

const TX = {} as DatabaseTransaction;

const REFERENCE = '7f3c1a52-8d4e-4b6a-9c21-0e5d7a9b3f10';

const INPUT: IngestPaymentInput = {
  reference: null,
  provider: 'fake',
  providerPaymentId: 'provider-1',
  status: 'succeeded',
  amountMinor: 1000,
  currency: 'USD',
  purpose: 'one_off',
  reason: 'test',
  webhookEventId: null,
};

const RENEWAL_INPUT: IngestPaymentInput = {
  ...INPUT,
  purpose: 'subscription_renewal',
};

const paymentWith = (overrides: Partial<Payment> = {}): Payment => ({
  id: REFERENCE,
  provider: 'fake',
  providerPaymentId: null,
  purpose: 'one_off',
  origin: 'api',
  status: 'created',
  amountMinor: 1000,
  currency: 'USD',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  reconcileAfter: null,
  reconciledAt: null,
  reconcileAttempts: 0,
  projectId: SEED_PROJECT_ID,
  providerAccountId: SEED_FAKE_ACCOUNT_ID,
  ...overrides,
});

const repositoryWith = (
  overrides: Partial<Record<keyof PaymentsRepository, jest.Mock>>,
): PaymentsRepository =>
  ({
    withTransaction: jest.fn((work: (tx: DatabaseTransaction) => unknown) =>
      Promise.resolve(work(TX)),
    ),
    findById: jest.fn().mockResolvedValue(null),
    requestReconciliation: jest.fn().mockResolvedValue(undefined),
    insertIfAbsent: jest.fn().mockResolvedValue(null),
    findByProviderRefForUpdate: jest.fn().mockResolvedValue(null),
    findByIdAndProviderForUpdate: jest.fn().mockResolvedValue(null),
    setProviderPaymentId: jest.fn().mockResolvedValue(null),
    updateStatus: jest.fn().mockResolvedValue(null),
    insertEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as PaymentsRepository;

describe('PaymentsService', () => {
  describe('getPayment', () => {
    it('returns only the public fields of the payment', async () => {
      const service = new PaymentsService(
        repositoryWith({
          findById: jest.fn().mockResolvedValue(
            paymentWith({
              providerPaymentId: 'provider-1',
              status: 'pending',
            }),
          ),
        }),
      );

      expect({ ...(await service.getPayment(REFERENCE)) }).toEqual({
        paymentId: REFERENCE,
        status: 'pending',
        provider: 'fake',
        amountMinor: 1000,
        currency: 'USD',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
    });

    it('throws payment_not_found when the id is unknown', async () => {
      const service = new PaymentsService(repositoryWith({}));

      await expect(service.getPayment(REFERENCE)).rejects.toMatchObject({
        body: {
          statusCode: 404,
          code: 'payment_not_found',
          message: 'Payment not found',
        },
      });
    });

    it.each(['created', 'pending'] as const)(
      'asks for a reconciliation of a %s payment',
      async (status) => {
        const requestReconciliation = jest.fn().mockResolvedValue(undefined);
        const service = new PaymentsService(
          repositoryWith({
            findById: jest.fn().mockResolvedValue(paymentWith({ status })),
            requestReconciliation,
          }),
        );

        await service.getPayment(REFERENCE);

        expect(requestReconciliation).toHaveBeenCalledWith(REFERENCE);
      },
    );

    it('still returns the payment when the reconciliation request fails', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const service = new PaymentsService(
        repositoryWith({
          findById: jest
            .fn()
            .mockResolvedValue(paymentWith({ status: 'pending' })),
          requestReconciliation: jest
            .fn()
            .mockRejectedValue(
              new Error('canceling statement due to lock timeout'),
            ),
        }),
      );

      await expect(service.getPayment(REFERENCE)).resolves.toMatchObject({
        paymentId: REFERENCE,
        status: 'pending',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(REFERENCE));
      warn.mockRestore();
    });

    it.each([
      'succeeded',
      'partially_refunded',
      'refunded',
      'failed',
      'expired',
    ] as const)(
      'does not ask for a reconciliation of a %s payment',
      async (status) => {
        const requestReconciliation = jest.fn().mockResolvedValue(undefined);
        const service = new PaymentsService(
          repositoryWith({
            findById: jest.fn().mockResolvedValue(paymentWith({ status })),
            requestReconciliation,
          }),
        );

        await service.getPayment(REFERENCE);

        expect(requestReconciliation).not.toHaveBeenCalled();
      },
    );
  });

  it('accepts only registered provider codes at compile time', () => {
    const inputWithUnregisteredProvider: IngestPaymentInput = {
      ...INPUT,
      // @ts-expect-error 'stripe' is not a ProviderCode
      provider: 'stripe',
    };

    expect(inputWithUnregisteredProvider.provider).toBe('stripe');
  });

  it('takes only the statuses a payment event can report at compile time', () => {
    const providerStatus = 'refunded' as ProviderPaymentStatus;
    const inputs: IngestPaymentInput[] = [
      // @ts-expect-error refund states come only from refund rows
      { ...INPUT, status: 'refunded' },
      // @ts-expect-error refund states come only from refund rows
      { ...INPUT, status: 'partially_refunded' },
      // @ts-expect-error created is our own row before the provider call
      { ...INPUT, status: 'created' },
      // @ts-expect-error a provider status may be a refund state
      { ...INPUT, status: providerStatus },
    ];

    expect(inputs).toHaveLength(4);
  });

  it.each([
    ['1.5', { amountMinor: 1.5 }, 'amountMinor'],
    ['9007199254740992', { amountMinor: 2 ** 53 }, 'amountMinor'],
    ['NaN', { amountMinor: Number.NaN }, 'amountMinor'],
    ['-1', { amountMinor: -1 }, 'amountMinor'],
    ['usd', { currency: 'usd' }, 'currency'],
    ['DOLLARS', { currency: 'DOLLARS' }, 'currency'],
  ])(
    'rejects %s without opening a transaction or echoing it',
    async (rawValue, overrides, field) => {
      const withTransaction = jest.fn();
      const paymentsService = new PaymentsService(
        repositoryWith({ withTransaction }),
      );

      const error: unknown = await paymentsService
        .ingestPayment({ ...INPUT, ...overrides })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PaymentEventInvalidError);
      expect(error).toMatchObject({ field });
      expect((error as Error).message).not.toContain(rawValue);
      expect(withTransaction).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty provider payment id without opening a transaction', async () => {
    const withTransaction = jest.fn();
    const paymentsService = new PaymentsService(
      repositoryWith({ withTransaction }),
    );

    const error: unknown = await paymentsService
      .ingestPayment({ ...RENEWAL_INPUT, providerPaymentId: '' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaymentEventInvalidError);
    expect(error).toMatchObject({ field: 'providerPaymentId' });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('accepts a zero amount, as the stored check does', async () => {
    const paymentsService = new PaymentsService(
      repositoryWith({
        insertIfAbsent: jest.fn().mockResolvedValue(paymentWith()),
      }),
    );

    const { outcome } = await paymentsService.ingestPayment({
      ...RENEWAL_INPUT,
      amountMinor: 0,
    });

    expect(outcome).toBe('created');
  });

  it.each([
    ['PaymentEventInvalidError', new PaymentEventInvalidError('currency')],
    [
      'PaymentMismatchError',
      new PaymentMismatchError(paymentWith(), {
        amountMinor: 1,
        currency: 'A',
      }),
    ],
    [
      'PaymentProviderRefMismatchError',
      new PaymentProviderRefMismatchError(paymentWith(), INPUT),
    ],
    ['PaymentProviderRefOwnedError', new PaymentProviderRefOwnedError(INPUT)],
  ])('classifies %s as rejected for the worker', (_name, error) => {
    expect(error).toBeInstanceOf(IngestRejectedError);
  });

  describe('unique violation mapping', () => {
    const violationOf = (code: string, constraintName: string): Error =>
      new Error('Failed query', {
        cause: { code, constraint_name: constraintName },
      });

    const ingestFailingWith = (failure: Error): Promise<unknown> =>
      new PaymentsService(
        repositoryWith({
          withTransaction: jest.fn().mockRejectedValue(failure),
        }),
      )
        .ingestPayment({ ...INPUT, reference: REFERENCE })
        .catch((caught: unknown) => caught);

    it('maps the provider ref constraint to the owned error', async () => {
      const failure = violationOf(
        '23505',
        'payments_provider_provider_payment_id_unique',
      );

      const error = await ingestFailingWith(failure);

      expect(error).toBeInstanceOf(PaymentProviderRefOwnedError);
      expect(error).toMatchObject({
        reference: REFERENCE,
        providerPaymentId: INPUT.providerPaymentId,
        cause: failure,
      });
    });

    it.each([
      ['another unique constraint', '23505', 'payment_events_unique'],
      [
        'another code on that constraint',
        '23503',
        'payments_provider_provider_payment_id_unique',
      ],
    ])('leaves %s as it is', async (_case, code, constraintName) => {
      const failure = violationOf(code, constraintName);

      expect(await ingestFailingWith(failure)).toBe(failure);
    });
  });

  describe('applyStatusInTransaction', () => {
    it('applies a status without comparing any amount', async () => {
      const updateStatus = jest
        .fn()
        .mockResolvedValue(paymentWith({ status: 'partially_refunded' }));
      const insertEvent = jest.fn().mockResolvedValue(undefined);
      const paymentsService = new PaymentsService(
        repositoryWith({ updateStatus, insertEvent }),
      );

      const { outcome } = await paymentsService.applyStatusInTransaction(TX, {
        payment: paymentWith({ status: 'succeeded' }),
        targetStatus: 'partially_refunded',
        reason: 'refund',
        webhookEventId: null,
      });

      expect(outcome).toBe('applied');
      expect(insertEvent).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({
          fromStatus: 'succeeded',
          toStatus: 'partially_refunded',
          outcome: 'applied',
          reason: 'refund',
        }),
      );
    });
  });

  describe('lockPaymentForRefund', () => {
    const LOOKUP = {
      reference: REFERENCE,
      provider: 'fake',
      providerPaymentId: 'provider-1',
    } as const;

    it('prefers the referenced row and links its null id', async () => {
      const linkedPayment = paymentWith({ providerPaymentId: 'provider-1' });
      const setProviderPaymentId = jest.fn().mockResolvedValue(linkedPayment);
      const findByProviderRefForUpdate = jest.fn();
      const paymentsService = new PaymentsService(
        repositoryWith({
          setProviderPaymentId,
          findByProviderRefForUpdate,
          findByIdAndProviderForUpdate: jest
            .fn()
            .mockResolvedValue(paymentWith()),
        }),
      );

      expect(await paymentsService.lockPaymentForRefund(TX, LOOKUP)).toBe(
        linkedPayment,
      );
      expect(findByProviderRefForUpdate).not.toHaveBeenCalled();
    });

    it('falls back to the provider ref and never creates a row', async () => {
      const insertIfAbsent = jest.fn();
      const findByProviderRefForUpdate = jest.fn().mockResolvedValue(null);
      const paymentsService = new PaymentsService(
        repositoryWith({ insertIfAbsent, findByProviderRefForUpdate }),
      );

      expect(await paymentsService.lockPaymentForRefund(TX, LOOKUP)).toBeNull();
      expect(findByProviderRefForUpdate).toHaveBeenCalledWith(
        TX,
        'fake',
        'provider-1',
      );
      expect(insertIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('payment birth', () => {
    it.each(['one_off', 'subscription_initial'] as const)(
      'throws a retryable not-found for %s without inserting',
      async (purpose) => {
        const insertIfAbsent = jest.fn();
        const paymentsService = new PaymentsService(
          repositoryWith({ insertIfAbsent }),
        );

        const error: unknown = await paymentsService
          .ingestPayment({ ...INPUT, purpose, reference: 'attempt-1' })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(PaymentNotFoundError);
        expect(error).not.toBeInstanceOf(IngestRejectedError);
        expect(error).toMatchObject({
          reference: 'attempt-1',
          providerPaymentId: INPUT.providerPaymentId,
        });
        expect(insertIfAbsent).not.toHaveBeenCalled();
      },
    );

    it('births a renewal with the provider origin and one birth event', async () => {
      const createdPayment = paymentWith({ origin: 'provider' });
      const insertIfAbsent = jest.fn().mockResolvedValue(createdPayment);
      const insertEvent = jest.fn().mockResolvedValue(undefined);
      const paymentsService = new PaymentsService(
        repositoryWith({ insertIfAbsent, insertEvent }),
      );

      const result = await paymentsService.ingestPayment(RENEWAL_INPUT);

      expect(result).toEqual({ payment: createdPayment, outcome: 'created' });
      expect(insertIfAbsent).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({
          origin: 'provider',
          purpose: 'subscription_renewal',
        }),
      );
      expect(insertEvent).toHaveBeenCalledTimes(1);
    });

    it('throws not-found when the conflicting renewal row is gone by the time it is locked', async () => {
      const paymentsService = new PaymentsService(repositoryWith({}));

      await expect(
        paymentsService.ingestPayment(RENEWAL_INPUT),
      ).rejects.toBeInstanceOf(PaymentNotFoundError);
    });
  });

  describe('reference lookup', () => {
    it.each([
      ['null', null],
      ['not a uuid', 'attempt-1'],
    ])(
      'skips the lookup when the reference is %s',
      async (_case, reference) => {
        const findByIdAndProviderForUpdate = jest.fn();
        const payment = paymentWith({ providerPaymentId: 'provider-1' });
        const paymentsService = new PaymentsService(
          repositoryWith({
            findByIdAndProviderForUpdate,
            insertIfAbsent: jest.fn().mockResolvedValue(payment),
          }),
        );

        const result = await paymentsService.ingestPayment({
          ...RENEWAL_INPUT,
          reference,
        });

        expect(result.outcome).toBe('created');
        expect(findByIdAndProviderForUpdate).not.toHaveBeenCalled();
      },
    );

    it('looks the row up by the reference and the provider', async () => {
      const findByIdAndProviderForUpdate = jest
        .fn()
        .mockResolvedValue(paymentWith({ providerPaymentId: 'provider-1' }));
      const paymentsService = new PaymentsService(
        repositoryWith({
          findByIdAndProviderForUpdate,
          updateStatus: jest
            .fn()
            .mockResolvedValue(paymentWith({ status: 'succeeded' })),
        }),
      );

      await paymentsService.ingestPayment({ ...INPUT, reference: REFERENCE });

      expect(findByIdAndProviderForUpdate).toHaveBeenCalledWith(
        TX,
        REFERENCE,
        'fake',
      );
    });

    it('rejects a different id on a linked row', async () => {
      const setProviderPaymentId = jest.fn();
      const paymentsService = new PaymentsService(
        repositoryWith({
          setProviderPaymentId,
          findByIdAndProviderForUpdate: jest
            .fn()
            .mockResolvedValue(paymentWith({ providerPaymentId: 'stored-id' })),
        }),
      );

      const error: unknown = await paymentsService
        .ingestPayment({ ...INPUT, reference: REFERENCE })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PaymentProviderRefMismatchError);
      expect(error).toMatchObject({
        paymentId: REFERENCE,
        storedProviderPaymentId: 'stored-id',
        receivedProviderPaymentId: INPUT.providerPaymentId,
      });
      expect(setProviderPaymentId).not.toHaveBeenCalled();
    });

    it('does not write the id again when it is already linked', async () => {
      const setProviderPaymentId = jest.fn();
      const payment = paymentWith({
        status: 'succeeded',
        providerPaymentId: INPUT.providerPaymentId,
      });
      const paymentsService = new PaymentsService(
        repositoryWith({
          setProviderPaymentId,
          findByIdAndProviderForUpdate: jest.fn().mockResolvedValue(payment),
        }),
      );

      const result = await paymentsService.ingestPayment({
        ...INPUT,
        reference: REFERENCE,
      });

      expect(result).toEqual({ payment, outcome: 'duplicate' });
      expect(setProviderPaymentId).not.toHaveBeenCalled();
    });

    it('rejects when the row lost its null id under the lock', async () => {
      const paymentsService = new PaymentsService(
        repositoryWith({
          findByIdAndProviderForUpdate: jest
            .fn()
            .mockResolvedValue(paymentWith()),
        }),
      );

      await expect(
        paymentsService.ingestPayment({ ...INPUT, reference: REFERENCE }),
      ).rejects.toThrow('Payment row disappeared during ingest');
    });
  });
});
