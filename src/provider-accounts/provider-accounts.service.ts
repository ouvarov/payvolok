import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { BoundProvider } from '@/providers/payment-provider.port';
import type { PaddleEnvironment } from '@/providers/provider-credentials';
import type { ProviderCode } from '@/providers/provider.constants';
import { ProviderRegistry } from '@/providers/provider.registry';

import {
  ProviderAccountsRepository,
  type StoredAccount,
} from './provider-accounts.repository';
import { ProviderCredentialsResolver } from './provider-credentials.resolver';

const providerAccountIdSchema = z.uuid();

type PaddleCheckoutAccount = {
  clientToken: string | null;
  environment: PaddleEnvironment;
};

@Injectable()
export class ProviderAccountsService {
  constructor(
    private readonly providerAccountsRepository: ProviderAccountsRepository,
    private readonly providerCredentialsResolver: ProviderCredentialsResolver,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  // Any status: a disabled account keeps its webhooks, reconciliation, refunds and checkout.
  async bind(accountId: string): Promise<BoundProvider> {
    const account = await this.providerAccountsRepository.findById(accountId);
    if (!account) {
      throw new Error(`Provider account ${accountId} does not exist`);
    }

    return this.bindAccount(account);
  }

  async bindForNewPayment(
    projectId: string,
    provider: ProviderCode,
  ): Promise<BoundProvider | null> {
    const account =
      await this.providerAccountsRepository.findByProjectAndProvider(
        projectId,
        provider,
      );
    if (account?.status !== 'active') return null;

    return this.bindAccount(account);
  }

  async bindForWebhook(
    provider: ProviderCode,
    accountId: string,
  ): Promise<BoundProvider | null> {
    const account = await this.findAccount(accountId);
    if (account?.provider !== provider) return null;

    return this.bindAccount(account);
  }

  async paddleCheckoutOf(
    accountId: string,
  ): Promise<PaddleCheckoutAccount | null> {
    const account = await this.findAccount(accountId);
    if (account?.provider !== 'paddle') return null;

    const credentials = await this.providerCredentialsResolver.resolve(account);
    if (credentials.provider !== 'paddle') return null;

    return {
      clientToken: credentials.clientToken?.reveal() ?? null,
      environment: credentials.environment,
    };
  }

  private findAccount(accountId: string): Promise<StoredAccount | null> {
    if (!providerAccountIdSchema.safeParse(accountId).success) {
      return Promise.resolve(null);
    }

    return this.providerAccountsRepository.findById(accountId);
  }

  private async bindAccount(account: StoredAccount): Promise<BoundProvider> {
    const credentials = await this.providerCredentialsResolver.resolve(account);

    return this.providerRegistry.bind(account, credentials);
  }
}

export type { PaddleCheckoutAccount };
