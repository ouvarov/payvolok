import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '@/config/env.schema';
import { ProviderError } from '@/providers/payment-provider.port';
import {
  RedactedSecret,
  type FakeCredentials,
  type PaddleCredentials,
  type ProviderCredentials,
  type StripeCredentials,
} from '@/providers/provider-credentials';

import {
  SEED_FAKE_CREDENTIALS_REF,
  SEED_PADDLE_CREDENTIALS_REF,
  SEED_STRIPE_CREDENTIALS_REF,
} from './provider-accounts.constants';
import {
  ProviderCredentialsResolver,
  type CredentialedAccount,
} from './provider-credentials.resolver';

const FAKE_WEBHOOK_SECRET_BYTES = 32;

const secretOrNull = (value: string | undefined): RedactedSecret | null =>
  value === undefined ? null : new RedactedSecret(value);

const paddleCredentialsOf = (
  configService: ConfigService<Env, true>,
): PaddleCredentials => {
  const webhookSecret = secretOrNull(
    configService.get('PADDLE_WEBHOOK_SECRET', { infer: true }),
  );

  return {
    provider: 'paddle',
    environment: 'sandbox',
    apiKey: secretOrNull(configService.get('PADDLE_API_KEY', { infer: true })),
    webhookSecrets: webhookSecret ? [webhookSecret] : [],
    clientToken: secretOrNull(
      configService.get('PADDLE_CLIENT_TOKEN', { infer: true }),
    ),
  };
};

const stripeCredentialsOf = (
  configService: ConfigService<Env, true>,
): StripeCredentials => {
  const webhookSecret = secretOrNull(
    configService.get('STRIPE_WEBHOOK_SECRET', { infer: true }),
  );

  return {
    provider: 'stripe',
    secretKey: secretOrNull(
      configService.get('STRIPE_SECRET_KEY', { infer: true }),
    ),
    webhookSecrets: webhookSecret ? [webhookSecret] : [],
  };
};

const fakeCredentialsOf = (
  configService: ConfigService<Env, true>,
): FakeCredentials => {
  const secret =
    configService.get('FAKE_WEBHOOK_SECRET', { infer: true }) ??
    randomBytes(FAKE_WEBHOOK_SECRET_BYTES).toString('hex');

  return { provider: 'fake', webhookSecrets: [new RedactedSecret(secret)] };
};

const missingCredentialsError = (account: CredentialedAccount): ProviderError =>
  new ProviderError(`provider account ${account.id} has no credentials`, {
    providerCode: account.provider,
    kind: 'misconfigured',
  });

// A fixed map read once from the validated config, so no credential bypasses the env schema.
@Injectable()
export class EnvCredentialsResolver extends ProviderCredentialsResolver {
  private readonly credentialsByRef: ReadonlyMap<string, ProviderCredentials>;

  constructor(configService: ConfigService<Env, true>) {
    super();
    this.credentialsByRef = new Map<string, ProviderCredentials>([
      [SEED_PADDLE_CREDENTIALS_REF, paddleCredentialsOf(configService)],
      [SEED_STRIPE_CREDENTIALS_REF, stripeCredentialsOf(configService)],
      [SEED_FAKE_CREDENTIALS_REF, fakeCredentialsOf(configService)],
    ]);
  }

  resolve(account: CredentialedAccount): Promise<ProviderCredentials> {
    const credentials = this.credentialsFor(account.credentialsRef);
    if (credentials?.provider !== account.provider) {
      return Promise.reject(missingCredentialsError(account));
    }

    return Promise.resolve(credentials);
  }

  protected credentialsFor(credentialsRef: string): ProviderCredentials | null {
    return this.credentialsByRef.get(credentialsRef) ?? null;
  }
}
