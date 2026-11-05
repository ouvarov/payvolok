import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { FakeProvider } from './fake/fake.provider';
import { ProvidersModule } from './providers.module';

const SECRET = 's'.repeat(32);
const RAW_BODY = Buffer.from('{"eventId":"event-1"}');

@Module({})
class ConfigStubModule {}

const fakeProviderWith = async (secret?: string): Promise<FakeProvider> => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      {
        module: ConfigStubModule,
        global: true,
        providers: [
          { provide: ConfigService, useValue: { get: () => secret } },
        ],
        exports: [ConfigService],
      },
      ProvidersModule,
    ],
  }).compile();

  return moduleRef.get(FakeProvider);
};

describe('ProvidersModule', () => {
  it('lets two instances with one secret verify each other', async () => {
    const signingProvider = await fakeProviderWith(SECRET);
    const verifyingProvider = await fakeProviderWith(SECRET);

    await expect(
      verifyingProvider.verifyWebhook(signingProvider.signRawBody(RAW_BODY)),
    ).resolves.toBe(true);
  });

  it('gives two instances with no secret different random secrets', async () => {
    const signingProvider = await fakeProviderWith();
    const verifyingProvider = await fakeProviderWith();

    await expect(
      verifyingProvider.verifyWebhook(signingProvider.signRawBody(RAW_BODY)),
    ).resolves.toBe(false);
  });
});
