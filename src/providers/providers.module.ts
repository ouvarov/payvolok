import { randomBytes } from 'node:crypto';

import { Module } from '@nestjs/common';

import { FakeProvider } from './fake/fake.provider';
import { ProviderRegistry } from './provider.registry';

const FAKE_WEBHOOK_SECRET_BYTES = 32;

@Module({
  providers: [
    {
      provide: FakeProvider,
      useFactory: () =>
        new FakeProvider(randomBytes(FAKE_WEBHOOK_SECRET_BYTES)),
    },
    ProviderRegistry,
  ],
  exports: [FakeProvider, ProviderRegistry],
})
export class ProvidersModule {}
