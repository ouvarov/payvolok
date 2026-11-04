import type { DatabaseTransaction } from '@/database/drizzle';

import type { PaymentsRepository } from './payments.repository';
import { PaymentsService, type IngestPaymentInput } from './payments.service';

const TX = {} as DatabaseTransaction;

const INPUT: IngestPaymentInput = {
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

const repositoryWith = (
  overrides: Partial<Record<keyof PaymentsRepository, jest.Mock>>,
): PaymentsRepository =>
  ({
    withTransaction: jest.fn((work: (tx: DatabaseTransaction) => unknown) =>
      Promise.resolve(work(TX)),
    ),
    insertIfAbsent: jest.fn().mockResolvedValue(null),
    findByProviderRefForUpdate: jest.fn().mockResolvedValue(null),
    updateStatus: jest.fn().mockResolvedValue(null),
    insertEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as PaymentsRepository;

describe('PaymentsService', () => {
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
});
