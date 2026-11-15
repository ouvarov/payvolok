import type { ConfigService } from '@nestjs/config';

import { ApiException } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';
import type { DatabaseTransaction } from '@/database/drizzle';
import type { IdempotencyService } from '@/idempotency/idempotency.service';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import { SEED_FAKE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';
import type { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import type { BoundProvider } from '@/providers/payment-provider.port';

import type { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentCreationService } from './payment-creation.service';
import type { PaymentsService } from './payments.service';

const TX = {} as DatabaseTransaction;
const PAYMENT_ID = '0b9d6f0e-5a4b-4c1e-9f3a-222222222222';
const STORED_RESPONSE = { statusCode: 201, body: {}, isReplayed: true };

const DTO: CreatePaymentDto = {
  provider: 'fake',
  amountMinor: 1000,
  currency: 'USD',
  description: 'Order 42',
  returnUrl: 'https://shop.example/return',
};

const SEED_FAKE_PROVIDER = {
  accountId: SEED_FAKE_ACCOUNT_ID,
  projectId: SEED_PROJECT_ID,
  code: 'fake',
} as BoundProvider;

type Collaborators = {
  findReplay: jest.Mock;
  bindForNewPayment: jest.Mock;
  claim: jest.Mock;
  recordRequested: jest.Mock;
};

const collaboratorsWith = (
  provider: BoundProvider | null,
  replay: unknown = null,
): Collaborators => ({
  findReplay: jest.fn().mockResolvedValue(replay),
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
      get: () => 'https://payvolok.test',
    } as unknown as ConfigService<Env, true>,
  );

describe('PaymentCreationService', () => {
  it('answers 422 provider_not_available and claims no key when the provider has no active account', async () => {
    const collaborators = collaboratorsWith(null);

    const error = await serviceWith(collaborators)
      .createPayment('key-1', DTO)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).body).toEqual({
      statusCode: 422,
      code: 'provider_not_available',
      message: 'The provider is not available for this project',
    });
    expect(collaborators.bindForNewPayment).toHaveBeenCalledWith(
      SEED_PROJECT_ID,
      'fake',
    );
    expect(collaborators.claim).not.toHaveBeenCalled();
    expect(collaborators.recordRequested).not.toHaveBeenCalled();
  });

  it('records the payment under the bound account of the seed project', async () => {
    const collaborators = collaboratorsWith(SEED_FAKE_PROVIDER);

    await expect(
      serviceWith(collaborators).createPayment('key-1', DTO),
    ).resolves.toBe(STORED_RESPONSE);

    expect(collaborators.recordRequested).toHaveBeenCalledWith(TX, {
      projectId: SEED_PROJECT_ID,
      providerAccountId: SEED_FAKE_ACCOUNT_ID,
      provider: 'fake',
      amountMinor: 1000,
      currency: 'USD',
    });
  });

  it('replays a completed key before it checks the account', async () => {
    const collaborators = collaboratorsWith(null, STORED_RESPONSE);

    await expect(
      serviceWith(collaborators).createPayment('key-1', DTO),
    ).resolves.toBe(STORED_RESPONSE);

    expect(collaborators.findReplay).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'api:create_payment', key: 'key-1' }),
    );
    expect(collaborators.bindForNewPayment).not.toHaveBeenCalled();
    expect(collaborators.claim).not.toHaveBeenCalled();
  });
});
