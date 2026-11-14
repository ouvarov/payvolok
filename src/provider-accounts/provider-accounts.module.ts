import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';

import { ProviderAccountsRepository } from './provider-accounts.repository';
import { ProviderAccountsService } from './provider-accounts.service';

@Module({
  imports: [DatabaseModule],
  providers: [ProviderAccountsRepository, ProviderAccountsService],
  exports: [ProviderAccountsService],
})
export class ProviderAccountsModule {}
