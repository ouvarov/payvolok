import type { DatabaseTransaction } from '@/database/drizzle';
import type { Payment } from '@/database/schemas/payments.schema';

import type { PaymentsRepository } from './payments.repository';
import {
  PaymentProviderRefMismatchError,
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
  origin: 'demo',
  reason: 'test',
  webhookEventId: null,
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
  ...overrides,
});

const repositoryWith = (
  overrides: Partial<Record<keyof PaymentsRepository, jest.Mock>>,
): PaymentsRepository =>
  ({
    withTransaction: jest.fn((work: (tx: DatabaseTransaction) => unknown) =>
      Promise.resolve(work(TX)),
    ),
    insertIfAbsent: jest.fn().mockResolvedValue(null),
    findByProviderRefForUpdate: jest.fn().mockResolvedValue(null),
    findByIdAndProviderForUpdate: jest.fn().mockResolvedValue(null),
    setProviderPaymentId: jest.fn().mockResolvedValue(null),
    updateStatus: jest.fn().mockResolvedValue(null),
    insertEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as PaymentsRepository;

describe('PaymentsService', () => {
  it('accepts only registered provider codes at compile time', () => {
    const inputWithUnregisteredProvider: IngestPaymentInput = {
      ...INPUT,
      // @ts-expect-error 'stripe' is not a ProviderCode
      provider: 'stripe',
    };

    expect(inputWithUnregisteredProvider.provider).toBe('stripe');
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects amountMinor %s without opening a transaction',
    async (amountMinor) => {
      const withTransaction = jest.fn();
      const paymentsService = new PaymentsService(
        repositoryWith({ withTransaction }),
      );

      await expect(
        paymentsService.ingestPayment({ ...INPUT, amountMinor }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(withTransaction).not.toHaveBeenCalled();
    },
  );

  it('rejects when the conflicting row is gone by the time it is locked', async () => {
    const paymentsService = new PaymentsService(repositoryWith({}));

    await expect(paymentsService.ingestPayment(INPUT)).rejects.toThrow(
      'Payment row disappeared during ingest',
    );
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
          ...INPUT,
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
