import { Logger } from '@nestjs/common';

import type { Payment } from '@/database/schemas/payments.schema';
import type { PaymentCreationService } from '@/payments/payment-creation.service';
import {
  PaymentMismatchError,
  type IngestPaymentInput,
  type IngestPaymentResult,
  type PaymentsService,
} from '@/payments/payments.service';
import {
  ProviderError,
  type PaymentProvider,
  type ResourceStatus,
} from '@/providers/payment-provider.port';
import type { ProviderRegistry } from '@/providers/provider.registry';

import {
  PENDING_RECONCILE_DELAYS_SECONDS,
  REFUNDABLE_RECONCILE_DELAY_SECONDS,
} from './reconciliation.constants';
import type {
  ClaimedPayment,
  ReconciliationRepository,
} from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECONCILED_AT = new Date('2026-11-12T12:00:00.000Z');
const PAYMENT_ID = '0b9d6f0e-5a4b-4c1e-9f3a-111111111111';

const claimedWith = (
  overrides: Partial<ClaimedPayment> = {},
): ClaimedPayment => ({
  id: PAYMENT_ID,
  provider: 'fake',
  providerPaymentId: 'provider-1',
  status: 'pending',
  purpose: 'one_off',
  createdAt: new Date(RECONCILED_AT.getTime() - 60 * 60 * 1000),
  reconcileAttempts: 1,
  reconciledAt: RECONCILED_AT,
  ...overrides,
});

const paymentStatusWith = (
  overrides: Partial<Extract<ResourceStatus, { resource: 'payment' }>> = {},
): ResourceStatus => ({
  resource: 'payment',
  providerPaymentId: 'provider-1',
  status: 'succeeded',
  amountMinor: 1000,
  currency: 'USD',
  ...overrides,
});

const ingestedWith = (
  status: Payment['status'],
  outcome: IngestPaymentResult['outcome'],
): IngestPaymentResult => ({
  payment: { id: PAYMENT_ID, status } as Payment,
  outcome,
});

const secondsAfterClaim = (next: Date | null): number | null =>
  next === null ? null : (next.getTime() - RECONCILED_AT.getTime()) / 1000;

describe('ReconciliationService', () => {
  let getStatus: jest.Mock<Promise<ResourceStatus | null>, []>;
  let ingestPayment: jest.Mock<
    Promise<IngestPaymentResult>,
    [IngestPaymentInput]
  >;
  let closeInterrupted: jest.Mock;
  let finish: jest.Mock<Promise<boolean>, [ClaimedPayment, Date | null]>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let service: ReconciliationService;

  const scheduledSeconds = (): number | null =>
    secondsAfterClaim(finish.mock.calls[0][1]);

  beforeEach(() => {
    getStatus = jest
      .fn<Promise<ResourceStatus | null>, []>()
      .mockResolvedValue(paymentStatusWith());
    ingestPayment = jest
      .fn<Promise<IngestPaymentResult>, [IngestPaymentInput]>()
      .mockResolvedValue(ingestedWith('succeeded', 'applied'));
    closeInterrupted = jest.fn();
    finish = jest
      .fn<Promise<boolean>, [ClaimedPayment, Date | null]>()
      .mockResolvedValue(true);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    service = new ReconciliationService(
      { ingestPayment } as unknown as PaymentsService,
      { closeInterrupted } as unknown as PaymentCreationService,
      {
        get: () => ({ getStatus }) as unknown as PaymentProvider,
      } as unknown as ProviderRegistry,
      { finish } as unknown as ReconciliationRepository,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a payment with a provider id', () => {
    it('ingests the provider status as a reconciliation without a webhook', async () => {
      const result = await service.reconcile(claimedWith());

      expect(ingestPayment).toHaveBeenCalledWith({
        reference: PAYMENT_ID,
        provider: 'fake',
        providerPaymentId: 'provider-1',
        status: 'succeeded',
        amountMinor: 1000,
        currency: 'USD',
        purpose: 'one_off',
        reason: 'reconciliation',
        webhookEventId: null,
      });
      expect(result).toEqual({
        outcome: 'checked',
        scopeKey: 'fake',
        isChanged: true,
      });
      expect(scheduledSeconds()).toBe(REFUNDABLE_RECONCILE_DELAY_SECONDS);
    });

    it.each(['refunded', 'partially_refunded'] as const)(
      'ingests a %s payment as succeeded',
      async (status) => {
        getStatus.mockResolvedValue(paymentStatusWith({ status }));

        await service.reconcile(claimedWith());

        expect(ingestPayment.mock.calls[0][0].status).toBe('succeeded');
      },
    );

    it('does not ingest a status behind ours', async () => {
      getStatus.mockResolvedValue(paymentStatusWith({ status: 'refunded' }));

      const result = await service.reconcile(
        claimedWith({ status: 'partially_refunded' }),
      );

      expect(ingestPayment).not.toHaveBeenCalled();
      expect(result).toMatchObject({ outcome: 'checked', isChanged: false });
      expect(scheduledSeconds()).toBe(REFUNDABLE_RECONCILE_DELAY_SECONDS);
    });

    it('backs a still pending payment off by its attempt count', async () => {
      getStatus.mockResolvedValue(paymentStatusWith({ status: 'pending' }));
      ingestPayment.mockResolvedValue(ingestedWith('pending', 'duplicate'));

      const result = await service.reconcile(
        claimedWith({ reconcileAttempts: 4 }),
      );

      expect(result).toMatchObject({ isChanged: false });
      expect(scheduledSeconds()).toBe(PENDING_RECONCILE_DELAYS_SECONDS[3]);
    });

    it('stops checking once the payment reaches a final status', async () => {
      getStatus.mockResolvedValue(paymentStatusWith({ status: 'expired' }));
      ingestPayment.mockResolvedValue(ingestedWith('expired', 'applied'));

      await service.reconcile(claimedWith());

      expect(finish.mock.calls[0][1]).toBeNull();
    });

    it('warns and backs off when the provider does not know the payment', async () => {
      getStatus.mockResolvedValue(null);

      await service.reconcile(claimedWith());

      expect(ingestPayment).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(scheduledSeconds()).toBe(PENDING_RECONCILE_DELAYS_SECONDS[0]);
    });

    it('logs a rejected ingest with the payment id and backs off', async () => {
      ingestPayment.mockRejectedValue(
        new PaymentMismatchError(
          { id: PAYMENT_ID, amountMinor: 1000, currency: 'USD' },
          { amountMinor: 999, currency: 'USD' },
        ),
      );

      await expect(service.reconcile(claimedWith())).resolves.toMatchObject({
        outcome: 'checked',
        isChanged: false,
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining(PAYMENT_ID));
      expect(scheduledSeconds()).toBe(PENDING_RECONCILE_DELAYS_SECONDS[0]);
    });

    it('lets any other ingest error through', async () => {
      ingestPayment.mockRejectedValue(new Error('connection lost'));

      await expect(service.reconcile(claimedWith())).rejects.toThrow(
        'connection lost',
      );
    });

    it.each(['unavailable', 'misconfigured'] as const)(
      'reports a provider that is %s and backs off',
      async (kind) => {
        getStatus.mockRejectedValue(
          new ProviderError('down', { providerCode: 'fake', kind }),
        );

        const result = await service.reconcile(claimedWith());

        expect(result).toEqual({
          outcome: 'provider_failed',
          scopeKey: 'fake',
          failure: { kind, detail: 'down' },
        });
        expect(scheduledSeconds()).toBe(PENDING_RECONCILE_DELAYS_SECONDS[0]);
      },
    );

    it('logs a rejected status query without skipping the provider', async () => {
      getStatus.mockRejectedValue(
        new ProviderError('bad id', { providerCode: 'fake', kind: 'rejected' }),
      );

      await expect(service.reconcile(claimedWith())).resolves.toMatchObject({
        outcome: 'checked',
      });
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('stops with a warning when the next check falls past 30 days', async () => {
      getStatus.mockResolvedValue(paymentStatusWith({ status: 'pending' }));
      ingestPayment.mockResolvedValue(ingestedWith('pending', 'duplicate'));

      await service.reconcile(
        claimedWith({
          reconcileAttempts: 20,
          createdAt: new Date(RECONCILED_AT.getTime() - 29.9 * DAY_MS),
        }),
      );

      expect(finish.mock.calls[0][1]).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('after 30 days; reconciliation stopped'),
      );
    });
  });

  describe('a payment without a provider id', () => {
    it('closes a created payment locally without asking the provider', async () => {
      closeInterrupted.mockResolvedValue({
        isClosed: true,
        result: ingestedWith('failed', 'applied'),
      });

      const result = await service.reconcile(
        claimedWith({ status: 'created', providerPaymentId: null }),
      );

      expect(closeInterrupted).toHaveBeenCalledWith({
        paymentId: PAYMENT_ID,
        provider: 'fake',
      });
      expect(getStatus).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'local', isChanged: true });
      expect(finish.mock.calls[0][1]).toBeNull();
    });

    it('backs off while its request still holds the key', async () => {
      closeInterrupted.mockResolvedValue({ isClosed: false });

      await service.reconcile(
        claimedWith({ status: 'created', providerPaymentId: null }),
      );

      expect(scheduledSeconds()).toBe(PENDING_RECONCILE_DELAYS_SECONDS[0]);
    });

    it('logs a pending one as an error and stops', async () => {
      await service.reconcile(claimedWith({ providerPaymentId: null }));

      expect(closeInterrupted).not.toHaveBeenCalled();
      expect(getStatus).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(finish.mock.calls[0][1]).toBeNull();
    });
  });
});
