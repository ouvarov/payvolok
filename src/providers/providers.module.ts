import { randomBytes } from 'node:crypto';

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '@/config/env.schema';

import { FakeProvider } from './fake/fake.provider';
import { ProviderRegistry } from './provider.registry';

const FAKE_WEBHOOK_SECRET_BYTES = 32;

@Module({
  providers: [
    {
      provide: FakeProvider,
      useFactory: (configService: ConfigService<Env, true>) => {
        const secret = configService.get('FAKE_WEBHOOK_SECRET', {
          infer: true,
        });

        return new FakeProvider(
          secret ? Buffer.from(secret) : randomBytes(FAKE_WEBHOOK_SECRET_BYTES),
        );
      },
      inject: [ConfigService],
    },
    ProviderRegistry,
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
