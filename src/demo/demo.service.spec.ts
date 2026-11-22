import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { ApiException } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';
import type { PaymentCreationService } from '@/payments/payment-creation.service';
import type { RecentPaymentCount } from '@/payments/payments.repository';
import type { PaymentsService } from '@/payments/payments.service';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';

import { DemoService } from './demo.service';
import { demoTokenOf } from './demo-token';

const SECRET = 's'.repeat(32);
const PAYMENT_ID = '0b9d6f0e-5a4b-4c1e-9f3a-111111111111';
const WEB_ORIGIN = 'https://web.example.test';
const CREATED_BODY = {
  paymentId: PAYMENT_ID,
  checkout: { type: 'redirect', url: 'https://checkout.example.test/1' },
};

type Collaborators = {
  createPayment: jest.Mock;
  countRecentDemoPayments: jest.Mock;
  getDemoPayment: jest.Mock;
};

const collaboratorsWith = (
  response: object = {
    statusCode: 201,
    body: CREATED_BODY,
    isReplayed: false,
  },
  recentCount: RecentPaymentCount = {
    count: 0,
    secondsUntilOldestLeaves: null,
  },
): Collaborators => ({
  createPayment: jest.fn().mockResolvedValue(response),
  countRecentDemoPayments: jest.fn().mockResolvedValue(recentCount),
  getDemoPayment: jest.fn().mockResolvedValue({ paymentId: PAYMENT_ID }),
});

const serviceWith = (
  collaborators: Collaborators,
  env: Partial<Env> = {},
): DemoService => {
  const fullEnv: Partial<Env> = {
    DEMO_TOKEN_SECRET: SECRET,
    DEMO_DAILY_PAYMENT_LIMIT: 50,
    WEB_ORIGIN,
    ...env,
  };

  return new DemoService(
    {
      createPayment: collaborators.createPayment,
    } as unknown as PaymentCreationService,
    {
      countRecentDemoPayments: collaborators.countRecentDemoPayments,
      getDemoPayment: collaborators.getDemoPayment,
    } as unknown as PaymentsService,
    {
      get: (key: keyof Env) => fullEnv[key],
    } as unknown as ConfigService<Env, true>,
  );
};

const errorOf = (work: Promise<unknown>): Promise<unknown> =>
  work.catch((caught: unknown) => caught);

describe('DemoService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createPayment', () => {
    it('creates a demo payment of the seed project with the fixed fields', async () => {
      const collaborators = collaboratorsWith();

      await serviceWith(collaborators).createPayment('key-1', {
        provider: 'stripe',
        amountMinor: 1000,
      });

      expect(collaborators.createPayment).toHaveBeenCalledWith({
        projectId: SEED_PROJECT_ID,
        origin: 'demo',
        idempotencyKey: 'key-1',
        payment: {
          provider: 'stripe',
          amountMinor: 1000,
          currency: 'USD',
          description: 'PayVolok demo payment',
          returnUrl: `${WEB_ORIGIN}/?checkout=returned`,
        },
      });
    });

    it.each([false, true])(
      'adds the payment token to a 201 (replayed: %s)',
      async (isReplayed) => {
        const collaborators = collaboratorsWith({
          statusCode: 201,
          body: CREATED_BODY,
          isReplayed,
        });

        const response = await serviceWith(collaborators).createPayment(
          'key-1',
          { provider: 'fake', amountMinor: 500 },
        );

        expect(response).toEqual({
          statusCode: 201,
          isReplayed,
          body: {
            ...CREATED_BODY,
            demoToken: demoTokenOf(SECRET, PAYMENT_ID),
          },
        });
      },
    );

    it('passes an error answer through without a token', async () => {
      const failure = {
        statusCode: 503,
        body: { code: 'provider_unavailable', paymentId: PAYMENT_ID },
        isReplayed: false,
      };

      await expect(
        serviceWith(collaboratorsWith(failure)).createPayment('key-1', {
          provider: 'fake',
          amountMinor: 500,
        }),
      ).resolves.toBe(failure);
    });

    it('answers 429 demo_limit_reached with the seconds until a slot frees, creating nothing', async () => {
      const collaborators = collaboratorsWith(undefined, {
        count: 2,
        secondsUntilOldestLeaves: 3600,
      });

      const error = await errorOf(
        serviceWith(collaborators, {
          DEMO_DAILY_PAYMENT_LIMIT: 2,
        }).createPayment('key-1', { provider: 'fake', amountMinor: 500 }),
      );

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).body).toMatchObject({
        statusCode: 429,
        code: 'demo_limit_reached',
      });
      expect((error as ApiException).retryAfterSeconds).toBe(3600);
      expect(collaborators.createPayment).not.toHaveBeenCalled();
    });

    it('creates while the count is one under the limit', async () => {
      const collaborators = collaboratorsWith(undefined, {
        count: 1,
        secondsUntilOldestLeaves: 3600,
      });

      await serviceWith(collaborators, {
        DEMO_DAILY_PAYMENT_LIMIT: 2,
      }).createPayment('key-1', { provider: 'fake', amountMinor: 500 });

      expect(collaborators.createPayment).toHaveBeenCalledTimes(1);
    });

    it('refuses every payment with limit 0 without counting', async () => {
      const collaborators = collaboratorsWith();

      const error = await errorOf(
        serviceWith(collaborators, {
          DEMO_DAILY_PAYMENT_LIMIT: 0,
        }).createPayment('key-1', { provider: 'fake', amountMinor: 500 }),
      );

      expect((error as ApiException).body).toMatchObject({
        code: 'demo_limit_reached',
      });
      expect(collaborators.countRecentDemoPayments).not.toHaveBeenCalled();
      expect(collaborators.createPayment).not.toHaveBeenCalled();
    });

    it('warns once while the limit stays reached', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const service = serviceWith(
        collaboratorsWith(undefined, {
          count: 2,
          secondsUntilOldestLeaves: 60,
        }),
        { DEMO_DAILY_PAYMENT_LIMIT: 2 },
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await errorOf(
          service.createPayment('key-1', {
            provider: 'fake',
            amountMinor: 500,
          }),
        );
      }

      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPayment', () => {
    it('reads a recent demo payment of the seed project for its token', async () => {
      const collaborators = collaboratorsWith();

      await serviceWith(collaborators).getPayment(
        PAYMENT_ID,
        demoTokenOf(SECRET, PAYMENT_ID),
      );

      expect(collaborators.getDemoPayment).toHaveBeenCalledWith(
        SEED_PROJECT_ID,
        PAYMENT_ID,
        24 * 60 * 60,
      );
    });

    it.each([
      ['no token', undefined],
      ['a token of another secret', demoTokenOf('t'.repeat(32), PAYMENT_ID)],
    ])('answers 404 for %s without reading', async (_case, token) => {
      const collaborators = collaboratorsWith();

      const error = await errorOf(
        serviceWith(collaborators).getPayment(PAYMENT_ID, token),
      );

      expect((error as ApiException).body).toEqual({
        statusCode: 404,
        code: 'payment_not_found',
        message: 'Payment not found',
      });
      expect(collaborators.getDemoPayment).not.toHaveBeenCalled();
    });
  });
});
