import type { ConfigService } from '@nestjs/config';

import { ApiException } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';
import type { DatabaseTransaction } from '@/database/drizzle';
import type { IdempotencyService } from '@/idempotency/idempotency.service';
import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import { SEED_FAKE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';
import type {
  AccountRef,
  ProviderAccountsService,
} from '@/provider-accounts/provider-accounts.service';
import type { ProviderRegistry } from '@/providers/provider.registry';

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

const SEED_FAKE_ACCOUNT: AccountRef = {
  id: SEED_FAKE_ACCOUNT_ID,
  projectId: SEED_PROJECT_ID,
  provider: 'fake',
};

type Collaborators = {
  activeAccountFor: jest.Mock;
  claim: jest.Mock;
  recordRequested: jest.Mock;
  get: jest.Mock;
};

const collaboratorsWith = (account: AccountRef | null): Collaborators => ({
  activeAccountFor: jest.fn().mockResolvedValue(account),
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
  get: jest.fn(),
});

const serviceWith = (collaborators: Collaborators): PaymentCreationService =>
  new PaymentCreationService(
    { claim: collaborators.claim } as unknown as IdempotencyService,
    {
      recordRequested: collaborators.recordRequested,
    } as unknown as PaymentsService,
    {
      activeAccountFor: collaborators.activeAccountFor,
    } as unknown as ProviderAccountsService,
    { get: collaborators.get } as unknown as ProviderRegistry,
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
    expect(collaborators.activeAccountFor).toHaveBeenCalledWith(
      SEED_PROJECT_ID,
      'fake',
    );
    expect(collaborators.claim).not.toHaveBeenCalled();
    expect(collaborators.recordRequested).not.toHaveBeenCalled();
    expect(collaborators.get).not.toHaveBeenCalled();
  });

  it('records the payment under the active account of the seed project', async () => {
    const collaborators = collaboratorsWith(SEED_FAKE_ACCOUNT);

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
});
