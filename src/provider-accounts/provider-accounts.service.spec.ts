import { SEED_PROJECT_ID } from '@/projects/projects.constants';

import { SEED_PADDLE_ACCOUNT_ID } from './provider-accounts.constants';
import type {
  ProviderAccountsRepository,
  StoredAccount,
} from './provider-accounts.repository';
import { ProviderAccountsService } from './provider-accounts.service';

const accountWith = (
  overrides: Partial<StoredAccount> = {},
): StoredAccount => ({
  id: SEED_PADDLE_ACCOUNT_ID,
  projectId: SEED_PROJECT_ID,
  provider: 'paddle',
  status: 'active',
  ...overrides,
});

const serviceWith = (
  findByProjectAndProvider: jest.Mock,
): ProviderAccountsService =>
  new ProviderAccountsService({
    findByProjectAndProvider,
  } as unknown as ProviderAccountsRepository);

const SEED_PADDLE_REF = {
  id: SEED_PADDLE_ACCOUNT_ID,
  projectId: SEED_PROJECT_ID,
  provider: 'paddle',
};

describe('ProviderAccountsService', () => {
  describe('activeAccountFor', () => {
    it('returns the account of the project and provider when it is active', async () => {
      const findByProjectAndProvider = jest
        .fn()
        .mockResolvedValue(accountWith());

      await expect(
        serviceWith(findByProjectAndProvider).activeAccountFor(
          SEED_PROJECT_ID,
          'paddle',
        ),
      ).resolves.toEqual(SEED_PADDLE_REF);
      expect(findByProjectAndProvider).toHaveBeenCalledWith(
        SEED_PROJECT_ID,
        'paddle',
      );
    });

    it.each([
      ['there is no account', null],
      ['the account is disabled', accountWith({ status: 'disabled' })],
    ])('returns null when %s', async (_case, account) => {
      await expect(
        serviceWith(jest.fn().mockResolvedValue(account)).activeAccountFor(
          SEED_PROJECT_ID,
          'paddle',
        ),
      ).resolves.toBeNull();
    });
  });

  describe('seedAccountOf', () => {
    it('returns the seed project account whatever its status', async () => {
      const findByProjectAndProvider = jest
        .fn()
        .mockResolvedValue(accountWith({ status: 'disabled' }));

      await expect(
        serviceWith(findByProjectAndProvider).seedAccountOf('paddle'),
      ).resolves.toEqual(SEED_PADDLE_REF);
      expect(findByProjectAndProvider).toHaveBeenCalledWith(
        SEED_PROJECT_ID,
        'paddle',
      );
    });

    it('returns null when the seed project has no account for the provider', async () => {
      await expect(
        serviceWith(jest.fn().mockResolvedValue(null)).seedAccountOf('fake'),
      ).resolves.toBeNull();
    });
  });
});
