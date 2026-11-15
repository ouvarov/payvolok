import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DRIZZLE, type Database } from '@/database/drizzle';
import {
  providerAccounts,
  type ProviderAccount,
} from '@/database/schemas/provider-accounts.schema';
import type { ProviderCode } from '@/providers/provider.constants';

type StoredAccount = Pick<
  ProviderAccount,
  'id' | 'projectId' | 'provider' | 'status'
>;

@Injectable()
export class ProviderAccountsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findByProjectAndProvider(
    projectId: string,
    provider: ProviderCode,
  ): Promise<StoredAccount | null> {
    const [account] = await this.db
      .select({
        id: providerAccounts.id,
        projectId: providerAccounts.projectId,
        provider: providerAccounts.provider,
        status: providerAccounts.status,
      })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.projectId, projectId),
          eq(providerAccounts.provider, provider),
        ),
      );

    return account ?? null;
  }
}

export type { StoredAccount };
