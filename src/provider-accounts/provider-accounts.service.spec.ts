import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import { FakeProvider } from '@/providers/fake/fake.provider';
import { PaddleProvider } from '@/providers/paddle/paddle.provider';
import {
  RedactedSecret,
  type ProviderCredentials,
} from '@/providers/provider-credentials';
import { ProviderRegistry } from '@/providers/provider.registry';

import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_PADDLE_ACCOUNT_ID,
} from './provider-accounts.constants';
import type {
  ProviderAccountsRepository,
  StoredAccount,
} from './provider-accounts.repository';
import { ProviderAccountsService } from './provider-accounts.service';

const CLIENT_TOKEN = `test_${'a1B'.repeat(9)}`;

const PADDLE_CREDENTIALS: ProviderCredentials = {
  provider: 'paddle',
  environment: 'sandbox',
  apiKey: null,
  webhookSecrets: [],
  clientToken: new RedactedSecret(CLIENT_TOKEN),
};

const FAKE_CREDENTIALS: ProviderCredentials = {
  provider: 'fake',
  webhookSecrets: [new RedactedSecret('s'.repeat(32))],
};

const accountWith = (
  overrides: Partial<StoredAccount> = {},
): StoredAccount => ({
  id: SEED_PADDLE_ACCOUNT_ID,
  projectId: SEED_PROJECT_ID,
  provider: 'paddle',
  status: 'active',
  credentialsRef: 'env:PADDLE',
  ...overrides,
});

const FAKE_ACCOUNT = accountWith({
  id: SEED_FAKE_ACCOUNT_ID,
  provider: 'fake',
  credentialsRef: 'env:FAKE',
});

type Collaborators = {
  findById: jest.Mock;
  findByProjectAndProvider: jest.Mock;
  resolve: jest.Mock;
};

const collaboratorsWith = (account: StoredAccount | null): Collaborators => ({
  findById: jest.fn().mockResolvedValue(account),
  findByProjectAndProvider: jest.fn().mockResolvedValue(account),
  resolve: jest.fn((stored: StoredAccount) =>
    Promise.resolve(
      stored.provider === 'paddle' ? PADDLE_CREDENTIALS : FAKE_CREDENTIALS,
    ),
  ),
});

const serviceWith = (collaborators: Collaborators): ProviderAccountsService =>
  new ProviderAccountsService(
    {
      findById: collaborators.findById,
      findByProjectAndProvider: collaborators.findByProjectAndProvider,
    } as unknown as ProviderAccountsRepository,
    { resolve: collaborators.resolve },
    new ProviderRegistry(new FakeProvider(), new PaddleProvider()),
  );

describe('ProviderAccountsService', () => {
  describe('bind', () => {
    it.each(['active', 'disabled'] as const)(
      'binds an %s account to its ids and credentials',
      async (status) => {
        const collaborators = collaboratorsWith(accountWith({ status }));

        const bound = await serviceWith(collaborators).bind(
          SEED_PADDLE_ACCOUNT_ID,
        );

        expect(bound).toMatchObject({
          accountId: SEED_PADDLE_ACCOUNT_ID,
          projectId: SEED_PROJECT_ID,
          code: 'paddle',
        });
        expect(collaborators.findById).toHaveBeenCalledWith(
          SEED_PADDLE_ACCOUNT_ID,
        );
        expect(collaborators.resolve).toHaveBeenCalledWith(
          accountWith({ status }),
        );
      },
    );

    it('rejects an account that does not exist', async () => {
      await expect(
        serviceWith(collaboratorsWith(null)).bind(SEED_PADDLE_ACCOUNT_ID),
      ).rejects.toThrow(`Provider account ${SEED_PADDLE_ACCOUNT_ID}`);
    });

    it('rejects when the credentials do not resolve', async () => {
      const collaborators = collaboratorsWith(accountWith());
      collaborators.resolve.mockRejectedValue(new Error('no credentials'));

      await expect(
        serviceWith(collaborators).bind(SEED_PADDLE_ACCOUNT_ID),
      ).rejects.toThrow('no credentials');
    });
  });

  describe('bindForNewPayment', () => {
    it('binds the active account of the project and provider', async () => {
      const collaborators = collaboratorsWith(FAKE_ACCOUNT);

      const bound = await serviceWith(collaborators).bindForNewPayment(
        SEED_PROJECT_ID,
        'fake',
      );

      expect(bound).toMatchObject({
        accountId: SEED_FAKE_ACCOUNT_ID,
        code: 'fake',
      });
      expect(collaborators.findByProjectAndProvider).toHaveBeenCalledWith(
        SEED_PROJECT_ID,
        'fake',
      );
    });

    it.each([
      ['there is no account', null],
      ['the account is disabled', { ...FAKE_ACCOUNT, status: 'disabled' }],
    ] as const)('returns null when %s', async (_case, account) => {
      const collaborators = collaboratorsWith(account);

      await expect(
        serviceWith(collaborators).bindForNewPayment(SEED_PROJECT_ID, 'fake'),
      ).resolves.toBeNull();
      expect(collaborators.resolve).not.toHaveBeenCalled();
    });
  });

  describe('bindForWebhook', () => {
    it('binds the account of the URL when its provider matches, whatever its status', async () => {
      const collaborators = collaboratorsWith({
        ...FAKE_ACCOUNT,
        status: 'disabled',
      });

      await expect(
        serviceWith(collaborators).bindForWebhook('fake', SEED_FAKE_ACCOUNT_ID),
      ).resolves.toMatchObject({ accountId: SEED_FAKE_ACCOUNT_ID });
    });

    it('returns null for an account of another provider', async () => {
      await expect(
        serviceWith(collaboratorsWith(accountWith())).bindForWebhook(
          'fake',
          SEED_PADDLE_ACCOUNT_ID,
        ),
      ).resolves.toBeNull();
    });

    it('returns null for an unknown account', async () => {
      await expect(
        serviceWith(collaboratorsWith(null)).bindForWebhook(
          'fake',
          SEED_FAKE_ACCOUNT_ID,
        ),
      ).resolves.toBeNull();
    });

    it('returns null for a non-uuid without a query', async () => {
      const collaborators = collaboratorsWith(FAKE_ACCOUNT);

      await expect(
        serviceWith(collaborators).bindForWebhook('fake', 'not-a-uuid'),
      ).resolves.toBeNull();
      expect(collaborators.findById).not.toHaveBeenCalled();
    });
  });

  describe('paddleCheckoutOf', () => {
    it.each(['sandbox', 'live'] as const)(
      'returns the client token and the %s environment of a Paddle account',
      async (environment) => {
        const collaborators = collaboratorsWith(accountWith());
        collaborators.resolve.mockResolvedValue({
          ...PADDLE_CREDENTIALS,
          environment,
        });

        await expect(
          serviceWith(collaborators).paddleCheckoutOf(SEED_PADDLE_ACCOUNT_ID),
        ).resolves.toEqual({ clientToken: CLIENT_TOKEN, environment });
      },
    );

    it('returns a null token for a Paddle account without a client token', async () => {
      const collaborators = collaboratorsWith(accountWith());
      collaborators.resolve.mockResolvedValue({
        ...PADDLE_CREDENTIALS,
        clientToken: null,
      });

      await expect(
        serviceWith(collaborators).paddleCheckoutOf(SEED_PADDLE_ACCOUNT_ID),
      ).resolves.toEqual({ clientToken: null, environment: 'sandbox' });
    });

    it.each([
      ['a fake account', FAKE_ACCOUNT, SEED_FAKE_ACCOUNT_ID],
      ['an unknown account', null, SEED_PADDLE_ACCOUNT_ID],
      ['a non-uuid', accountWith(), 'not-a-uuid'],
    ])('returns null for %s', async (_case, account, accountId) => {
      await expect(
        serviceWith(collaboratorsWith(account)).paddleCheckoutOf(accountId),
      ).resolves.toBeNull();
    });
  });
});
