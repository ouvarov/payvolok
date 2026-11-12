import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ApiErrorBody } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';
import type { DatabaseTransaction } from '@/database/drizzle';
import type {
  IdempotentRequest,
  StoredResponse,
} from '@/idempotency/idempotency.repository';
import {
  IdempotencyService,
  requestHashOf,
  type CloseInterruptedResult,
  type IdempotentResponse,
} from '@/idempotency/idempotency.service';
import type {
  CreatedPayment,
  ProviderErrorKind,
} from '@/providers/payment-provider.port';
import type { ProviderCode } from '@/providers/provider.constants';
import {
  providerFailureOf,
  type ProviderFailure,
} from '@/providers/provider-failure';
import { ProviderRegistry } from '@/providers/provider.registry';

import type { CreatePaymentDto } from './dto/create-payment.dto';
import { CreatedPaymentResponseDto } from './dto/created-payment-response.dto';
import { RECONCILIATION_INTERRUPTED_REASON } from './payment.constants';
import {
  PaymentsService,
  type ApiPaymentRef,
  type IngestPaymentResult,
} from './payments.service';

type ProviderOutcome =
  | { isCreated: true; created: CreatedPayment }
  | { isCreated: false; failure: ProviderFailure };

const errorResponseOf = (body: ApiErrorBody): StoredResponse => ({
  statusCode: body.statusCode,
  body,
});

const providerUnavailableResponseOf = (paymentId: string): StoredResponse =>
  errorResponseOf({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: 'provider_unavailable',
    message: 'The payment provider did not confirm the payment',
    paymentId,
  });

// misconfigured is our fault, not the client's: it answers like an outage.
const failureResponseOf = (
  kind: ProviderErrorKind,
  paymentId: string,
): StoredResponse =>
  kind === 'rejected'
    ? errorResponseOf({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'order_rejected',
        message: 'The payment provider rejected the payment',
      })
    : providerUnavailableResponseOf(paymentId);

const requestOf = (
  idempotencyKey: string,
  dto: CreatePaymentDto,
): IdempotentRequest => ({
  scope: 'api:create_payment',
  key: idempotencyKey,
  requestHash: requestHashOf([
    dto.provider,
    dto.amountMinor,
    dto.currency,
    dto.description,
    dto.returnUrl,
  ]),
});

@Injectable()
export class PaymentCreationService {
  private readonly logger = new Logger(PaymentCreationService.name);
  private readonly publicBaseUrl: string;

  constructor(
    private readonly idempotencyService: IdempotencyService,
    private readonly paymentsService: PaymentsService,
    private readonly providerRegistry: ProviderRegistry,
    configService: ConfigService<Env, true>,
  ) {
    this.publicBaseUrl = configService.get('PUBLIC_BASE_URL', { infer: true });
  }

  async createPayment(
    idempotencyKey: string,
    dto: CreatePaymentDto,
  ): Promise<IdempotentResponse> {
    const request = requestOf(idempotencyKey, dto);
    const claim = await this.idempotencyService.claim(request, {
      onClaimed: async (tx) => ({
        paymentId: (await this.paymentsService.recordRequested(tx, dto)).id,
      }),
      onInterrupted: (tx, paymentId) =>
        this.recordInterrupted(tx, { paymentId, provider: dto.provider }),
    });
    if (!claim.isOwner) {
      if (claim.recoveredPaymentId !== null) {
        this.logger.warn(
          `Payment ${claim.recoveredPaymentId}: its request was interrupted before the provider answer was stored`,
        );
      }

      return claim.response;
    }

    const ref = { paymentId: claim.claimed.paymentId, provider: dto.provider };
    const outcome = await this.callProvider(ref.paymentId, dto);
    const { response, isLeaseLost } = await this.idempotencyService.complete(
      request,
      ref.paymentId,
      (tx) => this.recordOutcome(tx, ref, outcome),
    );
    if (!outcome.isCreated) this.logFailure(ref, outcome.failure);
    if (isLeaseLost) {
      this.logger.warn(
        `Payment ${ref.paymentId}: the provider answered after a retry recovered the request; its outcome was recorded but the stored ${response.statusCode} was returned`,
      );
    }

    return response;
  }

  closeInterrupted(
    ref: ApiPaymentRef,
  ): Promise<CloseInterruptedResult<IngestPaymentResult>> {
    return this.idempotencyService.closeInterrupted(
      'api:create_payment',
      ref.paymentId,
      async (tx) => ({
        result: await this.paymentsService.recordFailed(
          tx,
          ref,
          RECONCILIATION_INTERRUPTED_REASON,
        ),
        response: providerUnavailableResponseOf(ref.paymentId),
      }),
    );
  }

  private async callProvider(
    paymentId: string,
    dto: CreatePaymentDto,
  ): Promise<ProviderOutcome> {
    try {
      const created = await this.providerRegistry
        .get(dto.provider)
        .createPayment({
          reference: paymentId,
          amountMinor: dto.amountMinor,
          currency: dto.currency,
          description: dto.description,
          returnUrl: dto.returnUrl,
          webhookUrl: this.webhookUrlOf(dto.provider),
        });

      return { isCreated: true, created };
    } catch (error) {
      return { isCreated: false, failure: providerFailureOf(error) };
    }
  }

  private async recordOutcome(
    tx: DatabaseTransaction,
    ref: ApiPaymentRef,
    outcome: ProviderOutcome,
  ): Promise<StoredResponse> {
    if (!outcome.isCreated) {
      const { kind, detail } = outcome.failure;
      await this.paymentsService.recordFailed(
        tx,
        ref,
        `provider_${kind}: ${detail}`,
      );

      return failureResponseOf(kind, ref.paymentId);
    }

    await this.paymentsService.recordCreated(tx, ref, outcome.created);

    return {
      statusCode: HttpStatus.CREATED,
      body: new CreatedPaymentResponseDto(
        ref.paymentId,
        outcome.created.redirectUrl,
      ),
    };
  }

  private async recordInterrupted(
    tx: DatabaseTransaction,
    ref: ApiPaymentRef,
  ): Promise<StoredResponse> {
    await this.paymentsService.recordInterrupted(tx, ref);

    return providerUnavailableResponseOf(ref.paymentId);
  }

  private logFailure(ref: ApiPaymentRef, failure: ProviderFailure): void {
    const message = `Payment ${ref.paymentId} failed at ${ref.provider}: provider_${failure.kind}: ${failure.detail}`;

    if (failure.kind === 'misconfigured') {
      this.logger.error(message);
      return;
    }

    this.logger.warn(message);
  }

  private webhookUrlOf(provider: ProviderCode): string {
    return `${this.publicBaseUrl}/webhooks/${provider}`;
  }
}
