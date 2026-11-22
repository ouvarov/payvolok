import { randomBytes } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiException } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';
import type { IdempotentResponse } from '@/idempotency/idempotency.service';
import type { CreatedPaymentResponseDto } from '@/payments/dto/created-payment-response.dto';
import type { PaymentResponseDto } from '@/payments/dto/payment-response.dto';
import { PaymentCreationService } from '@/payments/payment-creation.service';
import {
  paymentNotFoundException,
  PaymentsService,
} from '@/payments/payments.service';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';

import {
  DEMO_CURRENCY,
  DEMO_DESCRIPTION,
  DEMO_LIMIT_WINDOW_SECONDS,
  DEMO_RETURN_PATH,
  DEMO_TOKEN_TTL_SECONDS,
} from './demo.constants';
import { demoTokenOf, isDemoTokenOf } from './demo-token';
import type { CreateDemoPaymentDto } from './dto/create-demo-payment.dto';
import { CreatedDemoPaymentResponseDto } from './dto/created-demo-payment-response.dto';

const DEMO_TOKEN_SECRET_BYTES = 32;

const demoLimitReachedException = (retryAfterSeconds?: number): ApiException =>
  new ApiException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: 'demo_limit_reached',
      message: 'The demo payment limit is reached',
    },
    { retryAfterSeconds },
  );

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);
  private readonly demoTokenSecret: string;
  private readonly dailyPaymentLimit: number;
  private readonly returnUrl: string;
  private limitLoggedUntilEpochMs = 0;

  constructor(
    private readonly paymentCreationService: PaymentCreationService,
    private readonly paymentsService: PaymentsService,
    configService: ConfigService<Env, true>,
  ) {
    this.demoTokenSecret =
      configService.get('DEMO_TOKEN_SECRET', { infer: true }) ??
      randomBytes(DEMO_TOKEN_SECRET_BYTES).toString('base64url');
    this.dailyPaymentLimit = configService.get('DEMO_DAILY_PAYMENT_LIMIT', {
      infer: true,
    });
    this.returnUrl = `${configService.get('WEB_ORIGIN', { infer: true })}${DEMO_RETURN_PATH}`;
  }

  // The limit goes first, so a replay after it is reached is refused too.
  async createPayment(
    idempotencyKey: string,
    dto: CreateDemoPaymentDto,
  ): Promise<IdempotentResponse> {
    await this.assertUnderDailyLimit();
    const response = await this.paymentCreationService.createPayment({
      projectId: SEED_PROJECT_ID,
      origin: 'demo',
      idempotencyKey,
      payment: {
        provider: dto.provider,
        amountMinor: dto.amountMinor,
        currency: DEMO_CURRENCY,
        description: DEMO_DESCRIPTION,
        returnUrl: this.returnUrl,
      },
    });
    if (response.statusCode !== Number(HttpStatus.CREATED)) return response;

    // A stored 201 is always a created payment's answer.
    const created = response.body as CreatedPaymentResponseDto;
    if (!response.isReplayed) {
      this.logger.log(
        `Demo payment ${created.paymentId} created at ${dto.provider}`,
      );
    }

    return {
      ...response,
      body: new CreatedDemoPaymentResponseDto(
        created,
        demoTokenOf(this.demoTokenSecret, created.paymentId),
      ),
    };
  }

  // A wrong token, another payment's token or a payment that is not a recent demo one all look alike.
  async getPayment(
    paymentId: string,
    demoToken: string | undefined,
  ): Promise<PaymentResponseDto> {
    if (!isDemoTokenOf(this.demoTokenSecret, paymentId, demoToken)) {
      throw paymentNotFoundException();
    }

    return this.paymentsService.getDemoPayment(
      SEED_PROJECT_ID,
      paymentId,
      DEMO_TOKEN_TTL_SECONDS,
    );
  }

  private async assertUnderDailyLimit(): Promise<void> {
    if (this.dailyPaymentLimit === 0) throw demoLimitReachedException();

    const recent = await this.paymentsService.countRecentDemoPayments(
      DEMO_LIMIT_WINDOW_SECONDS,
    );
    if (recent.count < this.dailyPaymentLimit) return;

    const retryAfterSeconds = Math.max(1, recent.secondsUntilOldestLeaves ?? 1);
    this.logLimitReachedOnce(retryAfterSeconds);

    throw demoLimitReachedException(retryAfterSeconds);
  }

  // Every refused request would otherwise log, and anyone can send them.
  private logLimitReachedOnce(retryAfterSeconds: number): void {
    const nowEpochMs = Date.now();
    if (nowEpochMs < this.limitLoggedUntilEpochMs) return;

    this.limitLoggedUntilEpochMs = nowEpochMs + retryAfterSeconds * 1000;
    this.logger.warn(
      `Demo payment limit of ${this.dailyPaymentLimit} per ${DEMO_LIMIT_WINDOW_SECONDS} s reached; the next slot frees in ${retryAfterSeconds} s`,
    );
  }
}
