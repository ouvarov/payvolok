import { Injectable, Logger } from '@nestjs/common';

import type { PaymentStatus } from '@/payments/payment.constants';
import { decideTransition } from '@/payments/payment-state-machine';
import { PaymentCreationService } from '@/payments/payment-creation.service';
import {
  IngestRejectedError,
  PaymentsService,
  type IngestPaymentResult,
} from '@/payments/payments.service';
import type {
  PaymentProvider,
  ResourceStatus,
} from '@/providers/payment-provider.port';
import {
  providerFailureOf,
  type ProviderFailure,
} from '@/providers/provider-failure';
import { ProviderRegistry } from '@/providers/provider.registry';

import {
  ingestableStatusOf,
  nextReconcileAfterOf,
} from './reconciliation-schedule';
import {
  RECONCILE_WINDOW_DAYS,
  RECONCILIATION_REASON,
} from './reconciliation.constants';
import {
  ReconciliationRepository,
  reconciliationScopeKeyOf,
  type ClaimedPayment,
  type ReconciliationScopeKey,
} from './reconciliation.repository';

type PaymentStatusResource = Extract<ResourceStatus, { resource: 'payment' }>;

type ReconcileResult =
  | { outcome: 'local'; isChanged: boolean }
  | { outcome: 'checked'; scopeKey: ReconciliationScopeKey; isChanged: boolean }
  | {
      outcome: 'provider_failed';
      scopeKey: ReconciliationScopeKey;
      failure: ProviderFailure;
    };

type PaymentCheck = {
  result: ReconcileResult;
  status: PaymentStatus;
  isStopped: boolean;
};

type ProviderAnswer =
  | { isAnswered: true; status: ResourceStatus | null }
  | { isAnswered: false; failure: ProviderFailure };

const checkedCheckOf = (
  scopeKey: ReconciliationScopeKey,
  status: PaymentStatus,
  isChanged = false,
): PaymentCheck => ({
  result: { outcome: 'checked', scopeKey, isChanged },
  status,
  isStopped: false,
});

const isUnsettled = (status: PaymentStatus): boolean =>
  status === 'created' || status === 'pending';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly paymentCreationService: PaymentCreationService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly reconciliationRepository: ReconciliationRepository,
  ) {}

  async reconcile(claimed: ClaimedPayment): Promise<ReconcileResult> {
    const check = await this.check(claimed);
    await this.schedule(claimed, check);

    return check.result;
  }

  private check(claimed: ClaimedPayment): Promise<PaymentCheck> {
    if (claimed.providerPaymentId !== null) {
      return this.checkAtProvider(claimed, claimed.providerPaymentId);
    }
    if (claimed.status === 'created') return this.closeInterrupted(claimed);

    this.logger.error(
      `Payment ${claimed.id} is ${claimed.status} without a provider payment id; reconciliation stopped`,
    );

    return Promise.resolve({
      result: { outcome: 'local', isChanged: false },
      status: claimed.status,
      isStopped: true,
    });
  }

  private async closeInterrupted(
    claimed: ClaimedPayment,
  ): Promise<PaymentCheck> {
    const closed = await this.paymentCreationService.closeInterrupted({
      paymentId: claimed.id,
      provider: claimed.provider,
    });
    if (!closed.isClosed) {
      return {
        result: { outcome: 'local', isChanged: false },
        status: claimed.status,
        isStopped: false,
      };
    }

    const isChanged = this.logTransition(claimed, closed.result);

    return {
      result: { outcome: 'local', isChanged },
      status: closed.result.payment.status,
      isStopped: false,
    };
  }

  private async checkAtProvider(
    claimed: ClaimedPayment,
    providerPaymentId: string,
  ): Promise<PaymentCheck> {
    const scopeKey = reconciliationScopeKeyOf(claimed);
    const unchanged = checkedCheckOf(scopeKey, claimed.status);

    const answer = await this.askProvider(claimed, providerPaymentId);
    if (!answer.isAnswered) {
      if (answer.failure.kind === 'rejected') {
        this.logger.error(
          `Payment ${claimed.id} status was rejected by ${claimed.provider}: ${answer.failure.detail}`,
        );
        return unchanged;
      }

      return {
        ...unchanged,
        result: {
          outcome: 'provider_failed',
          scopeKey,
          failure: answer.failure,
        },
      };
    }
    if (answer.status === null) {
      this.logger.warn(
        `Payment ${claimed.id} is unknown to ${claimed.provider}; left ${claimed.status}`,
      );
      return unchanged;
    }
    if (answer.status.resource !== 'payment') {
      this.logger.error(
        `Payment ${claimed.id}: ${claimed.provider} answered with a ${answer.status.resource}`,
      );
      return unchanged;
    }

    return this.applyProviderStatus(claimed, answer.status, scopeKey);
  }

  private async applyProviderStatus(
    claimed: ClaimedPayment,
    providerStatus: PaymentStatusResource,
    scopeKey: ReconciliationScopeKey,
  ): Promise<PaymentCheck> {
    const unchanged = checkedCheckOf(scopeKey, claimed.status);
    const targetStatus = ingestableStatusOf(providerStatus.status);
    // A refunded payment reports a status behind ours; recording it as stale every day is noise.
    if (decideTransition(claimed.status, targetStatus) === 'stale') {
      return unchanged;
    }

    try {
      const ingested = await this.paymentsService.ingestPayment({
        reference: claimed.id,
        provider: claimed.provider,
        providerPaymentId: providerStatus.providerPaymentId,
        status: targetStatus,
        amountMinor: providerStatus.amountMinor,
        currency: providerStatus.currency,
        purpose: claimed.purpose,
        reason: RECONCILIATION_REASON,
        webhookEventId: null,
      });
      const isChanged = this.logTransition(claimed, ingested);

      return checkedCheckOf(scopeKey, ingested.payment.status, isChanged);
    } catch (error) {
      if (!(error instanceof IngestRejectedError)) throw error;

      this.logger.error(
        `Payment ${claimed.id} was not reconciled: ${error.message}`,
      );
      return unchanged;
    }
  }

  private async askProvider(
    claimed: ClaimedPayment,
    providerPaymentId: string,
  ): Promise<ProviderAnswer> {
    try {
      const status = await this.providerOf(claimed).getStatus({
        resource: 'payment',
        providerPaymentId,
      });

      return { isAnswered: true, status };
    } catch (error) {
      return { isAnswered: false, failure: providerFailureOf(error) };
    }
  }

  private providerOf(claimed: ClaimedPayment): PaymentProvider {
    return this.providerRegistry.get(claimed.provider);
  }

  private async schedule(
    claimed: ClaimedPayment,
    check: PaymentCheck,
  ): Promise<void> {
    if (check.isStopped) {
      await this.reconciliationRepository.finish(claimed, null);
      return;
    }

    const nextReconcileAfter = nextReconcileAfterOf({
      status: check.status,
      createdAt: claimed.createdAt,
      now: claimed.reconciledAt,
    });
    if (nextReconcileAfter === null && isUnsettled(check.status)) {
      this.logger.warn(
        `Payment ${claimed.id} still ${check.status} at ${claimed.provider} after ${RECONCILE_WINDOW_DAYS} days; reconciliation stopped`,
      );
    }

    await this.reconciliationRepository.finish(claimed, nextReconcileAfter);
  }

  private logTransition(
    claimed: ClaimedPayment,
    { payment, outcome }: IngestPaymentResult,
  ): boolean {
    if (outcome !== 'applied') return false;

    this.logger.log(
      `Payment ${claimed.id} reconciled: ${claimed.status} -> ${payment.status}`,
    );
    return true;
  }
}

export type { ReconcileResult };
