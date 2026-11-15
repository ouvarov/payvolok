import { inspect } from 'node:util';

import type { ConfigService } from '@nestjs/config';

import type { Env } from '@/config/env.schema';
import { ProviderError } from '@/providers/payment-provider.port';

import { EnvCredentialsResolver } from './env-credentials.resolver';
import {
  SEED_FAKE_ACCOUNT_ID,
  SEED_PADDLE_ACCOUNT_ID,
} from './provider-accounts.constants';
import type {
  FakeCredentials,
  PaddleCredentials,
  ProviderCredentials,
} from './provider-credentials';

const PADDLE_API_KEY = `pdl_sdbx_apikey_${'k'.repeat(53)}`;
const PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_01jcsyntheticsecret00000001_Wiring';
const PADDLE_CLIENT_TOKEN = `test_${'T0k'.repeat(9)}`;
const FAKE_WEBHOOK_SECRET = 'f'.repeat(32);
const ALL_SECRETS = [
  PADDLE_API_KEY,
  PADDLE_WEBHOOK_SECRET,
  PADDLE_CLIENT_TOKEN,
  FAKE_WEBHOOK_SECRET,
];

const PADDLE_ACCOUNT = {
  id: SEED_PADDLE_ACCOUNT_ID,
  provider: 'paddle' as const,
  credentialsRef: 'env:PADDLE',
};
const FAKE_ACCOUNT = {
  id: SEED_FAKE_ACCOUNT_ID,
  provider: 'fake' as const,
  credentialsRef: 'env:FAKE',
};

const FULL_ENV = {
  PADDLE_API_KEY,
  PADDLE_WEBHOOK_SECRET,
  PADDLE_CLIENT_TOKEN,
  FAKE_WEBHOOK_SECRET,
};

const resolverWith = (
  values: Readonly<Record<string, string>>,
): EnvCredentialsResolver =>
  new EnvCredentialsResolver({
    get: (key: string) => values[key],
  } as unknown as ConfigService<Env, true>);

const paddleCredentialsOf = async (
  resolver: EnvCredentialsResolver,
): Promise<PaddleCredentials> =>
  (await resolver.resolve(PADDLE_ACCOUNT)) as PaddleCredentials;

const fakeSecretOf = async (
  resolver: EnvCredentialsResolver,
): Promise<string[]> =>
  (
    (await resolver.resolve(FAKE_ACCOUNT)) as FakeCredentials
  ).webhookSecrets.map((secret) => secret.reveal());

const rejectionOf = async (
  work: Promise<ProviderCredentials>,
): Promise<ProviderError> => {
  const caught: unknown = await work.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(caught instanceof ProviderError)) {
    throw new Error('Expected a ProviderError');
  }

  return caught;
};

describe('EnvCredentialsResolver', () => {
  it('maps env:PADDLE to the sandbox and the PADDLE_* values', async () => {
    const credentials = await paddleCredentialsOf(resolverWith(FULL_ENV));

    expect(credentials.provider).toBe('paddle');
    expect(credentials.environment).toBe('sandbox');
    expect(credentials.apiKey?.reveal()).toBe(PADDLE_API_KEY);
    expect(credentials.webhookSecrets.map((secret) => secret.reveal())).toEqual(
      [PADDLE_WEBHOOK_SECRET],
    );
    expect(credentials.clientToken?.reveal()).toBe(PADDLE_CLIENT_TOKEN);
  });

  it('maps unset PADDLE_* values to null and no webhook secrets', async () => {
    await expect(paddleCredentialsOf(resolverWith({}))).resolves.toEqual({
      provider: 'paddle',
      environment: 'sandbox',
      apiKey: null,
      webhookSecrets: [],
      clientToken: null,
    });
  });

  it('maps env:FAKE to FAKE_WEBHOOK_SECRET', async () => {
    await expect(fakeSecretOf(resolverWith(FULL_ENV))).resolves.toEqual([
      FAKE_WEBHOOK_SECRET,
    ]);
  });

  it('keeps one random fake secret per resolver without FAKE_WEBHOOK_SECRET', async () => {
    const resolver = resolverWith({});
    const [secret] = await fakeSecretOf(resolver);

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    await expect(fakeSecretOf(resolver)).resolves.toEqual([secret]);
    await expect(fakeSecretOf(resolverWith({}))).resolves.not.toEqual([secret]);
  });

  it.each([
    ['an unknown ref', { ...PADDLE_ACCOUNT, credentialsRef: 'env:PADDLE_B' }],
    [
      'the ref of another provider',
      { ...PADDLE_ACCOUNT, credentialsRef: 'env:FAKE' },
    ],
  ])(
    'refuses %s as misconfigured, naming the account and no value',
    async (_case, account) => {
      const rejection = await rejectionOf(
        resolverWith(FULL_ENV).resolve(account),
      );

      expect(rejection.kind).toBe('misconfigured');
      expect(rejection.providerCode).toBe('paddle');
      expect(rejection.message).toBe(
        `provider account ${SEED_PADDLE_ACCOUNT_ID} has no credentials`,
      );
      for (const secret of ALL_SECRETS) {
        expect(inspect(rejection, { depth: null })).not.toContain(secret);
      }
    },
  );

  it.each([
    ['env:PADDLE', PADDLE_ACCOUNT],
    ['env:FAKE', FAKE_ACCOUNT],
  ])(
    'prints %s credentials as [redacted] in JSON, inspect and text',
    async (_ref, account) => {
      const credentials = await resolverWith(FULL_ENV).resolve(account);
      const printed = [
        JSON.stringify(credentials),
        inspect(credentials, { depth: null }),
        String(credentials.webhookSecrets[0]),
        [credentials.webhookSecrets[0]].join(''),
        String(credentials.webhookSecrets),
      ];

      for (const text of printed) {
        expect(text).toContain('[redacted]');
        for (const secret of ALL_SECRETS) {
          expect(text).not.toContain(secret);
        }
      }
    },
  );
});
