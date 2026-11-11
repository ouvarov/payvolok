import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';

import { FakeProvider } from './fake/fake.provider';
import {
  signedPaddleWebhook,
  transactionEventFixture,
  transactionResponseFixture,
} from './paddle/fixtures/paddle-fixtures';
import { PaddleCheckoutService } from './paddle/paddle-checkout.service';
import { PaddleProvider } from './paddle/paddle.provider';
import { ProvidersModule } from './providers.module';

const SECRET = 's'.repeat(32);
const RAW_BODY = Buffer.from('{"eventId":"event-1"}');
const PADDLE_API_KEY = `pdl_sdbx_apikey_${'k'.repeat(53)}`;
const PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_01jcsyntheticsecret00000001_Wiring';
const PADDLE_CLIENT_TOKEN = `test_${'T0k'.repeat(9)}`;

@Module({})
class ConfigStubModule {}

const moduleWith = (
  values: Readonly<Record<string, string>>,
): Promise<TestingModule> =>
  Test.createTestingModule({
    imports: [
      {
        module: ConfigStubModule,
        global: true,
        providers: [
          {
            provide: ConfigService,
            useValue: { get: (key: string) => values[key] },
          },
        ],
        exports: [ConfigService],
      },
      ProvidersModule,
    ],
  }).compile();

const fakeProviderWith = async (secret?: string): Promise<FakeProvider> =>
  (
    await moduleWith(
      secret === undefined ? {} : { FAKE_WEBHOOK_SECRET: secret },
    )
  ).get(FakeProvider);

const paddleModule = (): Promise<TestingModule> =>
  moduleWith({ PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_CLIENT_TOKEN });

describe('ProvidersModule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  it('gives the Paddle provider the webhook secret', async () => {
    const paddleProvider = (await paddleModule()).get(PaddleProvider);
    const body = transactionEventFixture('event-transaction-completed');

    await expect(
      paddleProvider.verifyWebhook(
        signedPaddleWebhook(body, PADDLE_WEBHOOK_SECRET, Date.now()),
      ),
    ).resolves.toBe(true);
  });

  it('gives the Paddle provider the API key', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify(transactionResponseFixture('transaction-created')),
          { status: 201 },
        ),
      );
    const paddleProvider = (await paddleModule()).get(PaddleProvider);

    await paddleProvider.createPayment({
      reference: '5b0b3a0e-6f0c-4c43-9d5e-0a8a7d5e1c11',
      amountMinor: 1000,
      currency: 'USD',
      description: 'wiring check',
      returnUrl: 'https://shop.example.test/return',
      webhookUrl: 'https://payvolok.example.test/webhooks/paddle',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Bearer ${PADDLE_API_KEY}`,
    });
  });

  it('gives the checkout page the client token and nothing secret', async () => {
    const page = (await paddleModule()).get(PaddleCheckoutService).render();

    expect(page.html).toContain(`token: "${PADDLE_CLIENT_TOKEN}"`);
    expect(page.html).not.toContain(PADDLE_API_KEY);
    expect(page.html).not.toContain(PADDLE_WEBHOOK_SECRET);
  });
});
