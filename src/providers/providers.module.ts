import { Module } from '@nestjs/common';

import { FakeProvider } from './fake/fake.provider';
import { PaddleProvider } from './paddle/paddle.provider';
import { ProviderRegistry } from './provider.registry';

@Module({
  providers: [
    { provide: FakeProvider, useFactory: () => new FakeProvider() },
    { provide: PaddleProvider, useFactory: () => new PaddleProvider() },
    ProviderRegistry,
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
