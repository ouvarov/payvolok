import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiException, type ApiErrorBody } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';
import type { DatabaseTransaction } from '@/database/drizzle';
import type { IdempotencyScope } from '@/idempotency/idempotency.constants';
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
import { ProjectsService } from '@/projects/projects.service';
import { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import type {
  BoundProvider,
  CreatedPayment,
  ProviderErrorKind,
} from '@/providers/payment-provider.port';
import type { ProviderCode } from '@/providers/provider.constants';
import {
  providerFailureOf,
  type ProviderFailure,
} from '@/providers/provider-failure';

import type { CreatePaymentDto } from './dto/create-payment.dto';
import { CreatedPaymentResponseDto } from './dto/created-payment-response.dto';
import {
  RECONCILIATION_INTERRUPTED_REASON,
  type PaymentOrigin,
} from './payment.constants';
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

type CreationOrigin = Extract<PaymentOrigin, 'api' | 'demo'>;

type PaymentCreationRequest = {
  projectId: string;
  origin: CreationOrigin;
  idempotencyKey: string;
  payment: CreatePaymentDto;
};

type InterruptedPaymentRef = ApiPaymentRef & { origin: PaymentOrigin };

const CREATE_PAYMENT_SCOPE_BY_ORIGIN: Readonly<
  Record<CreationOrigin, IdempotencyScope>
> = {
  api: 'api:create_payment',
  demo: 'demo:create_payment',
};

// Other origins never hold a creation key: the api scope finds none and the payment is still closed.
const createPaymentScopeOf = (origin: PaymentOrigin): IdempotencyScope =>
  origin === 'demo'
    ? CREATE_PAYMENT_SCOPE_BY_ORIGIN.demo
    : CREATE_PAYMENT_SCOPE_BY_ORIGIN.api;

const requestOf = ({
  projectId,
  origin,
  idempotencyKey,
  payment,
}: PaymentCreationRequest): IdempotentRequest => ({
  projectId,
  scope: CREATE_PAYMENT_SCOPE_BY_ORIGIN[origin],
  key: idempotencyKey,
  requestHash: requestHashOf([
    payment.provider,
    payment.amountMinor,
    payment.currency,
    payment.description,
    payment.returnUrl,
  ]),
});

@Injectable()
export class PaymentCreationService {
  private readonly logger = new Logger(PaymentCreationService.name);
  private readonly publicBaseUrl: string;

  constructor(
    private readonly idempotencyService: IdempotencyService,
    private readonly paymentsService: PaymentsService,
    private readonly providerAccountsService: ProviderAccountsService,
    private readonly projectsService: ProjectsService,
    configService: ConfigService<Env, true>,
  ) {
    this.publicBaseUrl = configService.get('PUBLIC_BASE_URL', { infer: true });
  }

  async createPayment(
    creationRequest: PaymentCreationRequest,
  ): Promise<IdempotentResponse> {
    const { projectId, origin, payment: dto } = creationRequest;
    const request = requestOf(creationRequest);
    // Before the project checks: a retry after the origins or the account changed still gets its stored answer.
    const replayed = await this.idempotencyService.findReplay(request);
    if (replayed) return replayed;

    await this.assertReturnUrlAllowed(projectId, dto.returnUrl);
    const provider = await this.availableProviderFor(projectId, dto.provider);
    const claim = await this.idempotencyService.claim(request, {
      onClaimed: async (tx) => ({
        paymentId: (
          await this.paymentsService.recordRequested(tx, {
            projectId: provider.projectId,
            providerAccountId: provider.accountId,
            provider: dto.provider,
            origin,
            amountMinor: dto.amountMinor,
            currency: dto.currency,
          })
        ).id,
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
    const outcome = await this.callProvider(provider, ref.paymentId, dto);
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

  closeInterrupted({
    origin,
    ...ref
  }: InterruptedPaymentRef): Promise<
    CloseInterruptedResult<IngestPaymentResult>
  > {
    return this.idempotencyService.closeInterrupted(
      createPaymentScopeOf(origin),
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

  private async assertReturnUrlAllowed(
    projectId: string,
    returnUrl: string,
  ): Promise<void> {
    if (await this.projectsService.isReturnUrlAllowed(projectId, returnUrl)) {
      return;
    }

    throw new ApiException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'return_url_not_allowed',
      message: 'The returnUrl origin is not allowed for this project',
    });
  }

  private async availableProviderFor(
    projectId: string,
    providerCode: ProviderCode,
  ): Promise<BoundProvider> {
    const provider = await this.providerAccountsService.bindForNewPayment(
      projectId,
      providerCode,
    );
    if (provider) return provider;

    throw new ApiException({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'provider_not_available',
      message: 'The provider is not available for this project',
    });
  }

  private async callProvider(
    provider: BoundProvider,
    paymentId: string,
    dto: CreatePaymentDto,
  ): Promise<ProviderOutcome> {
    try {
      const created = await provider.createPayment({
        reference: paymentId,
        amountMinor: dto.amountMinor,
        currency: dto.currency,
        description: dto.description,
        returnUrl: dto.returnUrl,
        webhookUrl: this.webhookUrlOf(provider),
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

  private webhookUrlOf(provider: BoundProvider): string {
    return `${this.publicBaseUrl}/webhooks/${provider.code}/${provider.accountId}`;
  }
}

export type { InterruptedPaymentRef, PaymentCreationRequest };
