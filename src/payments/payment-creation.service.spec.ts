import type { ConfigService } from '@nestjs/config';

import { ApiException } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';
import type { DatabaseTransaction } from '@/database/drizzle';
import type { IdempotencyService } from '@/idempotency/idempotency.service';
import type { ProjectsService } from '@/projects/projects.service';
import type { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import type { BoundProvider } from '@/providers/payment-provider.port';

import type { CreatePaymentDto } from './dto/create-payment.dto';
import {
  PaymentCreationService,
  type PaymentCreationRequest,
} from './payment-creation.service';
import type { PaymentsService } from './payments.service';

const TX = {} as DatabaseTransaction;
const PROJECT_ID = '3a7c9e1b-2d4f-4a6b-8c0d-111111111111';
const ACCOUNT_ID = '3a7c9e1b-2d4f-4a6b-8c0d-222222222222';
const PAYMENT_ID = '0b9d6f0e-5a4b-4c1e-9f3a-222222222222';
const STORED_RESPONSE = { statusCode: 201, body: {}, isReplayed: true };

const DTO: CreatePaymentDto = {
  provider: 'fake',
  amountMinor: 1000,
  currency: 'USD',
  description: 'Order 42',
  returnUrl: 'https://shop.example/return',
};

const REQUEST: PaymentCreationRequest = {
  projectId: PROJECT_ID,
  origin: 'api',
  idempotencyKey: 'key-1',
  payment: DTO,
};

const PROJECT_FAKE_PROVIDER = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  code: 'fake',
} as BoundProvider;

type Collaborators = {
  findReplay: jest.Mock;
  isReturnUrlAllowed: jest.Mock;
  bindForNewPayment: jest.Mock;
  claim: jest.Mock;
  recordRequested: jest.Mock;
};

const collaboratorsWith = ({
  provider = PROJECT_FAKE_PROVIDER,
  replay = null,
  isReturnUrlAllowed = true,
}: {
  provider?: BoundProvider | null;
  replay?: unknown;
  isReturnUrlAllowed?: boolean;
} = {}): Collaborators => ({
  findReplay: jest.fn().mockResolvedValue(replay),
  isReturnUrlAllowed: jest.fn().mockResolvedValue(isReturnUrlAllowed),
  bindForNewPayment: jest.fn().mockResolvedValue(provider),
  claim: jest.fn(
    async (
      _request: unknown,
      handlers: { onClaimed: (tx: DatabaseTransaction) => Promise<unknown> },
    ) => {
      await handlers.onClaimed(TX);

      return {
        isOwner: false,
        response: STORED_RESPONSE,
        recoveredPaymentId: null,
      };
    },
  ),
  recordRequested: jest.fn().mockResolvedValue({ id: PAYMENT_ID }),
});

const serviceWith = (collaborators: Collaborators): PaymentCreationService =>
  new PaymentCreationService(
    {
      findReplay: collaborators.findReplay,
      claim: collaborators.claim,
    } as unknown as IdempotencyService,
    {
      recordRequested: collaborators.recordRequested,
    } as unknown as PaymentsService,
    {
      bindForNewPayment: collaborators.bindForNewPayment,
    } as unknown as ProviderAccountsService,
    {
      isReturnUrlAllowed: collaborators.isReturnUrlAllowed,
    } as unknown as ProjectsService,
    {
      get: () => 'https://payvolok.test',
    } as unknown as ConfigService<Env, true>,
  );

const errorOf = (work: Promise<unknown>): Promise<unknown> =>
  work.catch((caught: unknown) => caught);

describe('PaymentCreationService', () => {
  it('answers 422 provider_not_available and claims no key when the project has no active account', async () => {
    const collaborators = collaboratorsWith({ provider: null });

    const error = await errorOf(
      serviceWith(collaborators).createPayment(REQUEST),
    );

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).body).toEqual({
      statusCode: 422,
      code: 'provider_not_available',
      message: 'The provider is not available for this project',
    });
    expect(collaborators.bindForNewPayment).toHaveBeenCalledWith(
      PROJECT_ID,
      'fake',
    );
    expect(collaborators.claim).not.toHaveBeenCalled();
    expect(collaborators.recordRequested).not.toHaveBeenCalled();
  });

  it('answers 400 return_url_not_allowed before binding an account or claiming the key', async () => {
    const collaborators = collaboratorsWith({ isReturnUrlAllowed: false });

    const error = await errorOf(
      serviceWith(collaborators).createPayment(REQUEST),
    );

    expect((error as ApiException).body).toEqual({
      statusCode: 400,
      code: 'return_url_not_allowed',
      message: 'The returnUrl origin is not allowed for this project',
    });
    expect(collaborators.isReturnUrlAllowed).toHaveBeenCalledWith(
      PROJECT_ID,
      DTO.returnUrl,
    );
    expect(collaborators.bindForNewPayment).not.toHaveBeenCalled();
    expect(collaborators.claim).not.toHaveBeenCalled();
  });

  it('claims the key in the caller project and records the payment under its bound account', async () => {
    const collaborators = collaboratorsWith();

    await expect(
      serviceWith(collaborators).createPayment(REQUEST),
    ).resolves.toBe(STORED_RESPONSE);

    expect(collaborators.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        scope: 'api:create_payment',
        key: 'key-1',
      }),
      expect.anything(),
    );
    expect(collaborators.recordRequested).toHaveBeenCalledWith(TX, {
      projectId: PROJECT_ID,
      providerAccountId: ACCOUNT_ID,
      provider: 'fake',
      origin: 'api',
      amountMinor: 1000,
      currency: 'USD',
    });
  });

  it('claims a demo request in the demo scope and records it with the demo origin', async () => {
    const collaborators = collaboratorsWith();

    await serviceWith(collaborators).createPayment({
      ...REQUEST,
      origin: 'demo',
    });

    expect(collaborators.findReplay).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'demo:create_payment', key: 'key-1' }),
    );
    expect(collaborators.claim).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'demo:create_payment', key: 'key-1' }),
      expect.anything(),
    );
    expect(collaborators.recordRequested).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ origin: 'demo' }),
    );
  });

  it('replays a completed key of the caller project before it checks the origin or the account', async () => {
    const collaborators = collaboratorsWith({
      provider: null,
      replay: STORED_RESPONSE,
      isReturnUrlAllowed: false,
    });

    await expect(
      serviceWith(collaborators).createPayment(REQUEST),
    ).resolves.toBe(STORED_RESPONSE);

    expect(collaborators.findReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        scope: 'api:create_payment',
        key: 'key-1',
      }),
    );
    expect(collaborators.isReturnUrlAllowed).not.toHaveBeenCalled();
    expect(collaborators.bindForNewPayment).not.toHaveBeenCalled();
    expect(collaborators.claim).not.toHaveBeenCalled();
  });
});
