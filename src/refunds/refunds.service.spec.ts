import type { DatabaseTransaction } from '@/database/drizzle';
import type { Payment } from '@/database/schemas/payments.schema';
import type { Refund } from '@/database/schemas/refunds.schema';
import {
  IngestRejectedError,
  type PaymentsService,
} from '@/payments/payments.service';

import type { RefundsRepository } from './refunds.repository';
import {
  RefundEventInvalidError,
  RefundMismatchError,
  RefundPaymentNotFoundError,
  RefundsService,
  type IngestRefundInput,
} from './refunds.service';

const TX = {} as DatabaseTransaction;

const REFUND_ID = '0d7a3f4e-2b1c-4e5f-8a6b-9c0d1e2f3a4b';

const INPUT: IngestRefundInput = {
  reference: null,
  provider: 'fake',
  providerPaymentId: 'provider-1',
  refundReference: null,
  providerRefundId: 'provider-refund-1',
  refundIdentity: 'provider',
  status: 'succeeded',
  amountMinor: 300,
  currency: 'USD',
  reason: 'test',
  webhookEventId: null,
};

const PAYMENT = {
  id: 'payment-1',
  status: 'succeeded',
  amountMinor: 1000,
  currency: 'USD',
} as Payment;

const refundWith = (overrides: Partial<Refund> = {}): Refund => ({
  id: REFUND_ID,
  paymentId: PAYMENT.id,
  provider: 'fake',
  providerRefundId: INPUT.providerRefundId,
  origin: 'provider',
  status: 'pending',
  amountMinor: 300,
  currency: 'USD',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const serviceWith = ({
  payments = {},
  refunds = {},
}: {
  payments?: Partial<Record<keyof PaymentsService, jest.Mock>>;
  refunds?: Partial<Record<keyof RefundsRepository, jest.Mock>>;
}): RefundsService =>
  new RefundsService(
    {
      runIngestTransaction: jest.fn(
        (_received: unknown, work: (tx: DatabaseTransaction) => unknown) =>
          Promise.resolve(work(TX)),
      ),
      lockPaymentForRefund: jest.fn().mockResolvedValue(PAYMENT),
      applyStatusInTransaction: jest
        .fn()
        .mockResolvedValue({ payment: PAYMENT, outcome: 'applied' }),
      ...payments,
    } as unknown as PaymentsService,
    {
      insertIfAbsent: jest.fn().mockResolvedValue(refundWith()),
      findById: jest.fn().mockResolvedValue(null),
      findByIdAndPayment: jest.fn().mockResolvedValue(null),
      findByProviderRef: jest.fn().mockResolvedValue(null),
      setProviderRefundId: jest.fn().mockResolvedValue(null),
      updateStatus: jest.fn().mockResolvedValue(null),
      sumSucceededMinor: jest.fn().mockResolvedValue(300),
      sumReservedMinor: jest.fn().mockResolvedValue(300),
      ...refunds,
    } as unknown as RefundsRepository,
  );

describe('RefundsService', () => {
  describe('input validation', () => {
    it.each([
      ['zero amount', { amountMinor: 0 }],
      ['negative amount', { amountMinor: -300 }],
      ['fractional amount', { amountMinor: 1.5 }],
      ['unsafe amount', { amountMinor: 2 ** 53 }],
      ['lowercase currency', { currency: 'usd' }],
      ['no id at all', { refundReference: null, providerRefundId: null }],
      ['an empty provider payment id', { providerPaymentId: '' }],
      ['an empty provider id', { providerRefundId: '' }],
      [
        'an empty provider id beside a uuid reference',
        { refundReference: REFUND_ID, providerRefundId: '' },
      ],
      [
        'only a reference that can never be a row id',
        { refundReference: 'attempt-1', providerRefundId: null },
      ],
    ])('rejects %s without opening a transaction', async (_case, overrides) => {
      const runIngestTransaction = jest.fn();
      const refundsService = serviceWith({
        payments: { runIngestTransaction },
      });

      await expect(
        refundsService.ingestRefund({ ...INPUT, ...overrides }),
      ).rejects.toBeInstanceOf(RefundEventInvalidError);
      expect(runIngestTransaction).not.toHaveBeenCalled();
    });

    it.each([
      ['a null provider id under provider', 'provider', REFUND_ID, null],
      ['a null reference under reference', 'reference', null, 'provider-id'],
      [
        'a non-uuid reference under reference',
        'reference',
        'attempt-1',
        'provider-id',
      ],
    ] as const)(
      'rejects %s without opening a transaction',
      async (_case, refundIdentity, refundReference, providerRefundId) => {
        const runIngestTransaction = jest.fn();
        const refundsService = serviceWith({
          payments: { runIngestTransaction },
        });

        const error: unknown = await refundsService
          .ingestRefund({
            ...INPUT,
            refundIdentity,
            refundReference,
            providerRefundId,
          })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RefundEventInvalidError);
        expect((error as Error).message).toBe(
          `Refund event is invalid: no ${refundIdentity} refund id`,
        );
        expect(runIngestTransaction).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a uuid reference under reference', 'reference', REFUND_ID, null],
      [
        'a non-uuid reference and a provider id under provider',
        'provider',
        'attempt-1',
        'provider-id',
      ],
    ] as const)(
      'accepts %s',
      async (_case, refundIdentity, refundReference, providerRefundId) => {
        const { refundOutcome } = await serviceWith({}).ingestRefund({
          ...INPUT,
          refundIdentity,
          refundReference,
          providerRefundId,
        });

        expect(refundOutcome).toBe('created');
      },
    );
  });

  describe('retry classification', () => {
    it('leaves a missing payment retryable', async () => {
      const error: unknown = await serviceWith({
        payments: { lockPaymentForRefund: jest.fn().mockResolvedValue(null) },
      })
        .ingestRefund(INPUT)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RefundPaymentNotFoundError);
      expect(error).not.toBeInstanceOf(IngestRejectedError);
    });

    it('classifies invalid events and mismatches as rejected', () => {
      expect(new RefundEventInvalidError('currency')).toBeInstanceOf(
        IngestRejectedError,
      );
      expect(new RefundMismatchError(null, 'currency')).toBeInstanceOf(
        IngestRejectedError,
      );
    });
  });

  describe('insert', () => {
    it('uses the reference as the row id so a redelivery finds the row', async () => {
      const insertIfAbsent = jest.fn().mockResolvedValue(refundWith());

      await serviceWith({ refunds: { insertIfAbsent } }).ingestRefund({
        ...INPUT,
        refundIdentity: 'reference',
        refundReference: REFUND_ID.toUpperCase(),
        providerRefundId: null,
      });

      expect(insertIfAbsent).toHaveBeenCalledWith(
        TX,
        expect.objectContaining({ id: REFUND_ID, origin: 'provider' }),
      );
    });

    it('lets the database pick the id without a usable reference', async () => {
      const insertIfAbsent = jest.fn().mockResolvedValue(refundWith());

      await serviceWith({ refunds: { insertIfAbsent } }).ingestRefund({
        ...INPUT,
        refundReference: 'attempt-1',
      });

      expect(insertIfAbsent).toHaveBeenCalledWith(
        TX,
        expect.not.objectContaining({ id: expect.anything() as unknown }),
      );
    });

    it('re-reads the owner and throws a mismatch on a conflict', async () => {
      const owner = refundWith({ paymentId: 'payment-2' });
      const findByProviderRef = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(owner);

      const error: unknown = await serviceWith({
        refunds: {
          findByProviderRef,
          insertIfAbsent: jest.fn().mockResolvedValue(null),
        },
      })
        .ingestRefund(INPUT)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RefundMismatchError);
      expect((error as Error).message).toContain('payment-2');
    });

    it('rejects when the conflicting row is gone on the re-read', async () => {
      await expect(
        serviceWith({
          refunds: { insertIfAbsent: jest.fn().mockResolvedValue(null) },
        }).ingestRefund(INPUT),
      ).rejects.toThrow('Refund row disappeared during ingest');
    });
  });

  describe('origin', () => {
    it('claims a row the provider reported first for our API refund with the same provider id', async () => {
      const setApiOrigin = jest
        .fn()
        .mockResolvedValue(refundWith({ origin: 'api' }));
      const updateStatus = jest
        .fn()
        .mockResolvedValue(refundWith({ origin: 'api', status: 'succeeded' }));

      const result = await serviceWith({
        refunds: {
          findByProviderRef: jest.fn().mockResolvedValue(refundWith()),
          setApiOrigin,
          updateStatus,
        },
      }).recordApiRefund(TX, INPUT);

      expect(setApiOrigin).toHaveBeenCalledWith(TX, REFUND_ID);
      expect(result.refund).toMatchObject({
        id: REFUND_ID,
        origin: 'api',
        status: 'succeeded',
      });
    });

    it.each([
      ['a provider report of our API refund', 'provider', 'api'],
      ['a provider report of a provider refund', 'provider', 'provider'],
      ['our API refund of a row we own', 'api', 'api'],
    ] as const)('keeps the origin on %s', async (_case, via, storedOrigin) => {
      const setApiOrigin = jest.fn();
      const service = serviceWith({
        refunds: {
          findByProviderRef: jest
            .fn()
            .mockResolvedValue(refundWith({ origin: storedOrigin })),
          setApiOrigin,
          updateStatus: jest.fn().mockResolvedValue(refundWith()),
        },
      });

      await (via === 'api'
        ? service.recordApiRefund(TX, INPUT)
        : service.ingestRefund(INPUT));

      expect(setApiOrigin).not.toHaveBeenCalled();
    });
  });

  describe('unique violation mapping', () => {
    const violationOf = (constraintName: string): Error =>
      new Error('Failed query', {
        cause: { code: '23505', constraint_name: constraintName },
      });

    const ingestFailingWith = (failure: Error): Promise<unknown> =>
      serviceWith({
        payments: {
          runIngestTransaction: jest.fn().mockRejectedValue(failure),
        },
      })
        .ingestRefund(INPUT)
        .catch((caught: unknown) => caught);

    it('maps the provider refund ref constraint to a mismatch', async () => {
      const failure = violationOf('refunds_provider_provider_refund_id_unique');

      const error = await ingestFailingWith(failure);

      expect(error).toBeInstanceOf(RefundMismatchError);
      expect(error).toMatchObject({ cause: failure });
    });

    it('leaves another constraint as it is', async () => {
      const failure = violationOf('refunds_pkey');

      expect(await ingestFailingWith(failure)).toBe(failure);
    });
  });

  describe('payment status', () => {
    it('leaves the payment alone while nothing has succeeded', async () => {
      const applyStatusInTransaction = jest.fn();

      const { paymentOutcome, payment } = await serviceWith({
        payments: { applyStatusInTransaction },
        refunds: { sumSucceededMinor: jest.fn().mockResolvedValue(0) },
      }).ingestRefund({ ...INPUT, status: 'pending' });

      expect(paymentOutcome).toBe('unchanged');
      expect(payment).toBe(PAYMENT);
      expect(applyStatusInTransaction).not.toHaveBeenCalled();
    });

    it('leaves the payment alone and still reports the total when the row did not change', async () => {
      const applyStatusInTransaction = jest.fn();

      const result = await serviceWith({
        payments: { applyStatusInTransaction },
        refunds: {
          findByProviderRef: jest
            .fn()
            .mockResolvedValue(refundWith({ status: 'succeeded' })),
          sumSucceededMinor: jest.fn().mockResolvedValue(1300),
        },
      }).ingestRefund(INPUT);

      expect(result).toMatchObject({
        refundOutcome: 'duplicate',
        paymentOutcome: 'unchanged',
        refundedTotalMinor: 1300,
      });
      expect(applyStatusInTransaction).not.toHaveBeenCalled();
    });

    it('leaves the payment alone when a refund is created pending beside a counted sum', async () => {
      const applyStatusInTransaction = jest.fn();

      const result = await serviceWith({
        payments: { applyStatusInTransaction },
        refunds: { sumSucceededMinor: jest.fn().mockResolvedValue(300) },
      }).ingestRefund({ ...INPUT, status: 'pending' });

      expect(result).toMatchObject({
        refundOutcome: 'created',
        paymentOutcome: 'unchanged',
        refundedTotalMinor: 300,
      });
      expect(applyStatusInTransaction).not.toHaveBeenCalled();
    });

    it('leaves the payment alone when a refund moves to failed beside a counted sum', async () => {
      const applyStatusInTransaction = jest.fn();

      const result = await serviceWith({
        payments: { applyStatusInTransaction },
        refunds: {
          findByProviderRef: jest.fn().mockResolvedValue(refundWith()),
          updateStatus: jest
            .fn()
            .mockResolvedValue(refundWith({ status: 'failed' })),
          sumSucceededMinor: jest.fn().mockResolvedValue(300),
        },
      }).ingestRefund({ ...INPUT, status: 'failed' });

      expect(result).toMatchObject({
        refundOutcome: 'applied',
        paymentOutcome: 'unchanged',
      });
      expect(applyStatusInTransaction).not.toHaveBeenCalled();
    });

    it('derives the target from the sum, not from the event amount', async () => {
      const applyStatusInTransaction = jest
        .fn()
        .mockResolvedValue({ payment: PAYMENT, outcome: 'applied' });

      await serviceWith({
        payments: { applyStatusInTransaction },
        refunds: {
          insertIfAbsent: jest
            .fn()
            .mockResolvedValue(refundWith({ status: 'succeeded' })),
          sumSucceededMinor: jest.fn().mockResolvedValue(1000),
        },
      }).ingestRefund({ ...INPUT, webhookEventId: 'event-1' });

      expect(applyStatusInTransaction).toHaveBeenCalledWith(TX, {
        payment: PAYMENT,
        targetStatus: 'refunded',
        reason: INPUT.reason,
        webhookEventId: 'event-1',
      });
    });
  });
});
