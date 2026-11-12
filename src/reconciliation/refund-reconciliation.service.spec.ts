import { Logger } from '@nestjs/common';

import type { Payment } from '@/database/schemas/payments.schema';
import type { Refund } from '@/database/schemas/refunds.schema';
import {
  ProviderError,
  type PaymentProvider,
  type ProviderRefundRecord,
  type RefundIdentity,
  type ResourceStatus,
  type StatusQuery,
} from '@/providers/payment-provider.port';
import {
  RefundMismatchError,
  type IngestRefundInput,
  type IngestRefundResult,
  type RefundsService,
} from '@/refunds/refunds.service';

import {
  RefundReconciliationService,
  type RefundablePayment,
} from './refund-reconciliation.service';

const PAYMENT: RefundablePayment = {
  id: '0b9d6f0e-5a4b-4c1e-9f3a-111111111111',
  provider: 'paddle',
  providerPaymentId: 'txn_01jcsyntheticpayment000001',
};
const PENDING_REFUND_ID = '8c6f9a52-0d6c-4c8e-9a7b-1f2e3d4c5b6a';

const recordWith = (
  overrides: Partial<ProviderRefundRecord> = {},
): ProviderRefundRecord => ({
  providerRefundId: 'adj_01jcsyntheticrefund0000001',
  status: 'succeeded',
  amountMinor: 400,
  currency: 'USD',
  ...overrides,
});

const pendingRefund = {
  id: PENDING_REFUND_ID,
  providerRefundId: null,
  status: 'pending',
} as Refund;

const ingestedWith = (
  overrides: Partial<IngestRefundResult> = {},
): IngestRefundResult => ({
  refund: {
    id: 'refund-1',
    providerRefundId: 'adj_1',
    status: 'succeeded',
  } as Refund,
  refundOutcome: 'duplicate',
  payment: { id: PAYMENT.id, status: 'partially_refunded' } as Payment,
  paymentOutcome: 'unchanged',
  refundedTotalMinor: 400,
  ...overrides,
});

const unavailable = (): ProviderError =>
  new ProviderError('down', { providerCode: 'paddle', kind: 'unavailable' });

describe('RefundReconciliationService', () => {
  let listRefunds: jest.Mock<
    Promise<readonly ProviderRefundRecord[]>,
    [string]
  >;
  let getStatus: jest.Mock<Promise<ResourceStatus | null>, [StatusQuery]>;
  let ingestRefund: jest.Mock<Promise<IngestRefundResult>, [IngestRefundInput]>;
  let findPendingRefunds: jest.Mock<Promise<Refund[]>, [string]>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let service: RefundReconciliationService;

  const providerWith = (refundIdentity: RefundIdentity): PaymentProvider =>
    ({
      capabilities: { refundIdentity },
      listRefunds,
      getStatus,
    }) as unknown as PaymentProvider;

  beforeEach(() => {
    listRefunds = jest
      .fn<Promise<readonly ProviderRefundRecord[]>, [string]>()
      .mockResolvedValue([recordWith()]);
    getStatus = jest
      .fn<Promise<ResourceStatus | null>, [StatusQuery]>()
      .mockResolvedValue({
        resource: 'refund',
        providerRefundId: null,
        status: 'succeeded',
        amountMinor: 400,
        currency: 'USD',
      });
    ingestRefund = jest
      .fn<Promise<IngestRefundResult>, [IngestRefundInput]>()
      .mockResolvedValue(ingestedWith());
    findPendingRefunds = jest
      .fn<Promise<Refund[]>, [string]>()
      .mockResolvedValue([pendingRefund]);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    service = new RefundReconciliationService({
      ingestRefund,
      findPendingRefunds,
    } as unknown as RefundsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a provider that identifies refunds by its own id', () => {
    const provider = () => providerWith('provider');

    it('ingests every listed refund by its provider id as a reconciliation', async () => {
      await service.reconcile(provider(), PAYMENT);

      expect(listRefunds).toHaveBeenCalledWith(PAYMENT.providerPaymentId);
      expect(ingestRefund).toHaveBeenCalledWith({
        reference: PAYMENT.id,
        provider: 'paddle',
        providerPaymentId: PAYMENT.providerPaymentId,
        refundReference: null,
        providerRefundId: 'adj_01jcsyntheticrefund0000001',
        refundIdentity: 'provider',
        status: 'succeeded',
        amountMinor: 400,
        currency: 'USD',
        reason: 'reconciliation',
        webhookEventId: null,
      });
      expect(findPendingRefunds).not.toHaveBeenCalled();
    });

    it('warns about a refund found only at the provider and reports the payment it moved', async () => {
      ingestRefund.mockResolvedValue(
        ingestedWith({ refundOutcome: 'created', paymentOutcome: 'applied' }),
      );

      await expect(service.reconcile(provider(), PAYMENT)).resolves.toEqual({
        isAnswered: true,
        isChanged: true,
        paymentStatus: 'partially_refunded',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('found only at the provider'),
      );
    });

    it('reports nothing changed for refunds it already had', async () => {
      await expect(service.reconcile(provider(), PAYMENT)).resolves.toEqual({
        isAnswered: true,
        isChanged: false,
        paymentStatus: 'partially_refunded',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs a rejected refund and ingests the next', async () => {
      listRefunds.mockResolvedValue([
        recordWith(),
        recordWith({ providerRefundId: 'adj_01jcsyntheticrefund0000002' }),
      ]);
      ingestRefund
        .mockRejectedValueOnce(new RefundMismatchError(PAYMENT.id, 'amount'))
        .mockResolvedValueOnce(ingestedWith({ refundOutcome: 'applied' }));

      await expect(service.reconcile(provider(), PAYMENT)).resolves.toEqual({
        isAnswered: true,
        isChanged: true,
        paymentStatus: 'partially_refunded',
      });
      expect(ingestRefund).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('adj_01jcsyntheticrefund0000001'),
      );
    });

    it('lets any other ingest error through', async () => {
      ingestRefund.mockRejectedValue(new Error('connection lost'));

      await expect(service.reconcile(provider(), PAYMENT)).rejects.toThrow(
        'connection lost',
      );
    });

    it('fails the check without writes when the list is unavailable', async () => {
      listRefunds.mockRejectedValue(unavailable());

      await expect(service.reconcile(provider(), PAYMENT)).resolves.toEqual({
        isAnswered: false,
        failure: { kind: 'unavailable', detail: 'down' },
      });
      expect(ingestRefund).not.toHaveBeenCalled();
    });

    it('logs a rejected list without failing the provider', async () => {
      listRefunds.mockRejectedValue(
        new ProviderError('bad id', {
          providerCode: 'paddle',
          kind: 'rejected',
        }),
      );

      await expect(service.reconcile(provider(), PAYMENT)).resolves.toEqual({
        isAnswered: true,
        isChanged: false,
        paymentStatus: null,
      });
      expect(error).toHaveBeenCalledTimes(1);
    });
  });

  describe('a provider that identifies refunds by our id', () => {
    const provider = () => providerWith('reference');

    it('asks for each pending refund by its id and ingests the answer', async () => {
      await service.reconcile(provider(), PAYMENT);

      expect(findPendingRefunds).toHaveBeenCalledWith(PAYMENT.id);
      expect(getStatus).toHaveBeenCalledWith({
        resource: 'refund',
        providerPaymentId: PAYMENT.providerPaymentId,
        providerRefundId: null,
        reference: PENDING_REFUND_ID,
      });
      expect(ingestRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          reference: PAYMENT.id,
          refundReference: PENDING_REFUND_ID,
          providerRefundId: null,
          refundIdentity: 'reference',
          status: 'succeeded',
          reason: 'reconciliation',
          webhookEventId: null,
        }),
      );
      expect(listRefunds).not.toHaveBeenCalled();
    });

    it('leaves a refund the provider does not know', async () => {
      getStatus.mockResolvedValue(null);

      await expect(service.reconcile(provider(), PAYMENT)).resolves.toEqual({
        isAnswered: true,
        isChanged: false,
        paymentStatus: null,
      });
      expect(ingestRefund).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(PENDING_REFUND_ID),
      );
    });

    it('stops at an unavailable provider', async () => {
      findPendingRefunds.mockResolvedValue([
        pendingRefund,
        { ...pendingRefund, id: 'refund-2' },
      ]);
      getStatus.mockRejectedValue(unavailable());

      await expect(service.reconcile(provider(), PAYMENT)).resolves.toEqual({
        isAnswered: false,
        failure: { kind: 'unavailable', detail: 'down' },
      });
      expect(getStatus).toHaveBeenCalledTimes(1);
    });

    it('logs a rejected query and asks about the next refund', async () => {
      findPendingRefunds.mockResolvedValue([
        pendingRefund,
        { ...pendingRefund, id: 'refund-2' },
      ]);
      getStatus.mockRejectedValueOnce(
        new ProviderError('bad id', {
          providerCode: 'paddle',
          kind: 'rejected',
        }),
      );

      await service.reconcile(provider(), PAYMENT);

      expect(getStatus).toHaveBeenCalledTimes(2);
      expect(ingestRefund).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    });
  });
});
