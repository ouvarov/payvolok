import { Injectable, Logger } from '@nestjs/common';

import type { DatabaseTransaction } from '@/database/drizzle';
import type { Payment } from '@/database/schemas/payments.schema';

import type {
  PaymentOrigin,
  PaymentPurpose,
  PaymentStatus,
} from './payment.constants';
import { decideTransition } from './payment-state-machine';
import { PaymentsRepository } from './payments.repository';

type IngestPaymentInput = {
  provider: string;
  providerPaymentId: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  purpose: PaymentPurpose;
  origin: PaymentOrigin;
  reason: string;
  webhookEventId: string | null;
};

type IngestPaymentResult = {
  payment: Payment;
  outcome: 'created' | 'applied' | 'duplicate' | 'stale' | 'conflict';
};

export class PaymentMismatchError extends Error {
  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} has a different amount or currency`);
    this.name = 'PaymentMismatchError';
  }
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly paymentsRepository: PaymentsRepository) {}

  async ingestPayment(input: IngestPaymentInput): Promise<IngestPaymentResult> {
    if (!Number.isSafeInteger(input.amountMinor)) {
      throw new RangeError('amountMinor must be a safe integer');
    }

    const result = await this.paymentsRepository.withTransaction((tx) =>
      this.ingestInTransaction(tx, input),
    );

    if (result.outcome === 'conflict') {
      this.logger.warn(
        `Payment ${result.payment.id} conflict: ${result.payment.status} -> ${input.status}`,
      );
    }

    return result;
  }

  private async ingestInTransaction(
    tx: DatabaseTransaction,
    input: IngestPaymentInput,
  ): Promise<IngestPaymentResult> {
    const createdPayment = await this.paymentsRepository.insertIfAbsent(tx, {
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      purpose: input.purpose,
      origin: input.origin,
      status: input.status,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });

    if (createdPayment) {
      await this.paymentsRepository.insertEvent(tx, {
        paymentId: createdPayment.id,
        fromStatus: null,
        toStatus: input.status,
        outcome: 'applied',
        reason: input.reason,
        webhookEventId: input.webhookEventId,
      });

      return { payment: createdPayment, outcome: 'created' };
    }

    const existingPayment =
      await this.paymentsRepository.findByProviderRefForUpdate(
        tx,
        input.provider,
        input.providerPaymentId,
      );

    if (!existingPayment) {
      throw new Error('Payment row disappeared during ingest');
    }

    return this.applyToExisting(tx, existingPayment, input);
  }

  private async applyToExisting(
    tx: DatabaseTransaction,
    existingPayment: Payment,
    input: IngestPaymentInput,
  ): Promise<IngestPaymentResult> {
    if (
      existingPayment.amountMinor !== input.amountMinor ||
      existingPayment.currency !== input.currency
    ) {
      throw new PaymentMismatchError(existingPayment.id);
    }

    const decision = decideTransition(existingPayment.status, input.status);

    if (decision === 'duplicate') {
      return { payment: existingPayment, outcome: 'duplicate' };
    }

    const currentPayment =
      decision === 'apply'
        ? await this.paymentsRepository.updateStatus(
            tx,
            existingPayment.id,
            input.status,
          )
        : existingPayment;

    if (!currentPayment) {
      throw new Error('Payment row disappeared during ingest');
    }

    const outcome = decision === 'apply' ? 'applied' : decision;

    await this.paymentsRepository.insertEvent(tx, {
      paymentId: existingPayment.id,
      fromStatus: existingPayment.status,
      toStatus: input.status,
      outcome,
      reason: input.reason,
      webhookEventId: input.webhookEventId,
    });

    return { payment: currentPayment, outcome };
  }
}

export type { IngestPaymentInput, IngestPaymentResult };
