import { Injectable } from '@nestjs/common';

import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import type { ProviderCode } from '@/providers/provider.constants';

import {
  ProviderAccountsRepository,
  type StoredAccount,
} from './provider-accounts.repository';

type AccountRef = { id: string; projectId: string; provider: ProviderCode };

const accountRefOf = ({
  id,
  projectId,
  provider,
}: StoredAccount): AccountRef => ({
  id,
  projectId,
  provider,
});

@Injectable()
export class ProviderAccountsService {
  constructor(
    private readonly providerAccountsRepository: ProviderAccountsRepository,
  ) {}

  async activeAccountFor(
    projectId: string,
    provider: ProviderCode,
  ): Promise<AccountRef | null> {
    const account =
      await this.providerAccountsRepository.findByProjectAndProvider(
        projectId,
        provider,
      );
    if (account?.status !== 'active') return null;

    return accountRefOf(account);
  }

  // Any status: a disabled account still takes webhooks for its payments.
  async seedAccountOf(provider: ProviderCode): Promise<AccountRef | null> {
    const account =
      await this.providerAccountsRepository.findByProjectAndProvider(
        SEED_PROJECT_ID,
        provider,
      );

    return account ? accountRefOf(account) : null;
  }
}

export type { AccountRef };
