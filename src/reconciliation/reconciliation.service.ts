import { Injectable, Logger } from '@nestjs/common';

import type { PaymentStatus } from '@/payments/payment.constants';
import { decideTransition } from '@/payments/payment-state-machine';
import { PaymentCreationService } from '@/payments/payment-creation.service';
import {
  IngestRejectedError,
  PaymentsService,
  type IngestPaymentResult,
} from '@/payments/payments.service';
import { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import type {
  BoundProvider,
  ResourceStatus,
} from '@/providers/payment-provider.port';
import type { ProviderCode } from '@/providers/provider.constants';
import {
  providerFailureOf,
  type ProviderFailure,
} from '@/providers/provider-failure';

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
import { RefundReconciliationService } from './refund-reconciliation.service';

type PaymentStatusResource = Extract<ResourceStatus, { resource: 'payment' }>;

type ScopedResult = {
  scopeKey: ReconciliationScopeKey;
  provider: ProviderCode;
};

type ReconcileResult =
  | { outcome: 'local'; isChanged: boolean }
  | (ScopedResult & { outcome: 'checked'; isChanged: boolean })
  | (ScopedResult & { outcome: 'provider_failed'; failure: ProviderFailure });

type PaymentCheck = {
  result: ReconcileResult;
  status: PaymentStatus;
  isStopped: boolean;
  boundProvider: BoundProvider | null;
};

type ProviderAnswer<Value> =
  | { isAnswered: true; value: Value }
  | { isAnswered: false; failure: ProviderFailure };

const askProvider = async <Value>(
  call: () => Promise<Value>,
): Promise<ProviderAnswer<Value>> => {
  try {
    return { isAnswered: true, value: await call() };
  } catch (error) {
    return { isAnswered: false, failure: providerFailureOf(error) };
  }
};

const checkedCheckOf = (
  provider: BoundProvider,
  status: PaymentStatus,
  isChanged = false,
): PaymentCheck => ({
  result: {
    outcome: 'checked',
    scopeKey: provider.accountId,
    provider: provider.code,
    isChanged,
  },
  status,
  isStopped: false,
  boundProvider: provider,
});

const localCheckOf = (
  status: PaymentStatus,
  isChanged: boolean,
  isStopped = false,
): PaymentCheck => ({
  result: { outcome: 'local', isChanged },
  status,
  isStopped,
  boundProvider: null,
});

const labelOf = (provider: BoundProvider): string =>
  `${provider.code} account ${provider.accountId}`;

const isUnsettled = (status: PaymentStatus): boolean =>
  status === 'created' || status === 'pending';

const isRefundable = (status: PaymentStatus): boolean =>
  status === 'succeeded' || status === 'partially_refunded';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly paymentCreationService: PaymentCreationService,
    private readonly providerAccountsService: ProviderAccountsService,
    private readonly reconciliationRepository: ReconciliationRepository,
    private readonly refundReconciliationService: RefundReconciliationService,
  ) {}

  async reconcile(claimed: ClaimedPayment): Promise<ReconcileResult> {
    const paymentCheck = await this.check(claimed);
    const check = await this.checkRefunds(claimed, paymentCheck);
    await this.schedule(claimed, check);

    return check.result;
  }

  private async checkRefunds(
    claimed: ClaimedPayment,
    check: PaymentCheck,
  ): Promise<PaymentCheck> {
    const { result, boundProvider } = check;
    if (
      result.outcome !== 'checked' ||
      boundProvider === null ||
      !isRefundable(check.status) ||
      claimed.providerPaymentId === null
    ) {
      return check;
    }

    const refunds = await this.refundReconciliationService.reconcile(
      boundProvider,
      { id: claimed.id, providerPaymentId: claimed.providerPaymentId },
    );
    if (!refunds.isAnswered) {
      return {
        ...check,
        result: {
          outcome: 'provider_failed',
          scopeKey: result.scopeKey,
          provider: result.provider,
          failure: refunds.failure,
        },
      };
    }

    return {
      ...check,
      result: { ...result, isChanged: result.isChanged || refunds.isChanged },
      status: refunds.paymentStatus ?? check.status,
    };
  }

  private check(claimed: ClaimedPayment): Promise<PaymentCheck> {
    if (claimed.providerPaymentId !== null) {
      return this.checkAtProvider(claimed, claimed.providerPaymentId);
    }
    if (claimed.status === 'created') return this.closeInterrupted(claimed);

    this.logger.error(
      `Payment ${claimed.id} is ${claimed.status} without a provider payment id; reconciliation stopped`,
    );

    return Promise.resolve(localCheckOf(claimed.status, false, true));
  }

  private async closeInterrupted(
    claimed: ClaimedPayment,
  ): Promise<PaymentCheck> {
    const closed = await this.paymentCreationService.closeInterrupted({
      paymentId: claimed.id,
      provider: claimed.provider,
    });
    if (!closed.isClosed) return localCheckOf(claimed.status, false);

    const isChanged = this.logTransition(claimed, closed.result);

    return localCheckOf(closed.result.payment.status, isChanged);
  }

  // A bind failure is a provider failure of that account, so the cycle skips only that account.
  private async checkAtProvider(
    claimed: ClaimedPayment,
    providerPaymentId: string,
  ): Promise<PaymentCheck> {
    const scopeKey = reconciliationScopeKeyOf(claimed);
    const bound = await askProvider(() =>
      this.providerAccountsService.bind(scopeKey),
    );
    if (!bound.isAnswered) {
      return {
        result: {
          outcome: 'provider_failed',
          scopeKey,
          provider: claimed.provider,
          failure: bound.failure,
        },
        status: claimed.status,
        isStopped: false,
        boundProvider: null,
      };
    }

    return this.checkStatusAt(claimed, providerPaymentId, bound.value);
  }

  private async checkStatusAt(
    claimed: ClaimedPayment,
    providerPaymentId: string,
    provider: BoundProvider,
  ): Promise<PaymentCheck> {
    const unchanged = checkedCheckOf(provider, claimed.status);

    const answer = await askProvider(() =>
      provider.getStatus({ resource: 'payment', providerPaymentId }),
    );
    if (!answer.isAnswered) {
      if (answer.failure.kind === 'rejected') {
        this.logger.error(
          `Payment ${claimed.id} status was rejected by ${labelOf(provider)}: ${answer.failure.detail}`,
        );
        return unchanged;
      }

      return {
        ...unchanged,
        result: {
          outcome: 'provider_failed',
          scopeKey: provider.accountId,
          provider: provider.code,
          failure: answer.failure,
        },
      };
    }
    if (answer.value === null) {
      this.logger.warn(
        `Payment ${claimed.id} is unknown to ${labelOf(provider)}; left ${claimed.status}`,
      );
      return unchanged;
    }
    if (answer.value.resource !== 'payment') {
      this.logger.error(
        `Payment ${claimed.id}: ${labelOf(provider)} answered with a ${answer.value.resource}`,
      );
      return unchanged;
    }

    return this.applyProviderStatus(claimed, answer.value, provider);
  }

  private async applyProviderStatus(
    claimed: ClaimedPayment,
    providerStatus: PaymentStatusResource,
    provider: BoundProvider,
  ): Promise<PaymentCheck> {
    const unchanged = checkedCheckOf(provider, claimed.status);
    const targetStatus = ingestableStatusOf(providerStatus.status);
    // A refunded payment reports a status behind ours; recording it as stale every day is noise.
    if (decideTransition(claimed.status, targetStatus) === 'stale') {
      return unchanged;
    }

    try {
      const ingested = await this.paymentsService.ingestPayment({
        reference: claimed.id,
        provider: provider.code,
        projectId: provider.projectId,
        providerAccountId: provider.accountId,
        providerPaymentId: providerStatus.providerPaymentId,
        status: targetStatus,
        amountMinor: providerStatus.amountMinor,
        currency: providerStatus.currency,
        purpose: claimed.purpose,
        reason: RECONCILIATION_REASON,
        webhookEventId: null,
      });
      const isChanged = this.logTransition(claimed, ingested);

      return checkedCheckOf(provider, ingested.payment.status, isChanged);
    } catch (error) {
      if (!(error instanceof IngestRejectedError)) throw error;

      this.logger.error(
        `Payment ${claimed.id} was not reconciled: ${error.message}`,
      );
      return unchanged;
    }
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
        `Payment ${claimed.id} still ${check.status} at ${claimed.provider} account ${claimed.providerAccountId} after ${RECONCILE_WINDOW_DAYS} days; reconciliation stopped`,
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
