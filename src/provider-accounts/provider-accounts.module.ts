import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { ProvidersModule } from '@/providers/providers.module';

import { EnvCredentialsResolver } from './env-credentials.resolver';
import { ProviderAccountsRepository } from './provider-accounts.repository';
import { ProviderAccountsService } from './provider-accounts.service';
import { ProviderCredentialsResolver } from './provider-credentials.resolver';

@Module({
  imports: [DatabaseModule, ProvidersModule],
  providers: [
    ProviderAccountsRepository,
    ProviderAccountsService,
    { provide: ProviderCredentialsResolver, useClass: EnvCredentialsResolver },
  ],
  exports: [ProviderAccountsService],
})
export class ProviderAccountsModule {}
