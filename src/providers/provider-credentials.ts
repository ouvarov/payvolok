import { inspect } from 'node:util';

import type { ProviderCode } from './provider.constants';

const REDACTED = '[redacted]';

// Logs, JSON and error causes only ever see the placeholder; reveal() is the one way to the value.
class RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

type PaddleEnvironment = 'sandbox' | 'live';

type PaddleCredentials = {
  provider: 'paddle';
  environment: PaddleEnvironment;
  apiKey: RedactedSecret | null;
  webhookSecrets: readonly RedactedSecret[];
  clientToken: RedactedSecret | null;
};

type StripeCredentials = {
  provider: 'stripe';
  secretKey: RedactedSecret | null;
  webhookSecrets: readonly RedactedSecret[];
};

type FakeCredentials = {
  provider: 'fake';
  webhookSecrets: readonly RedactedSecret[];
};

type ProviderCredentials =
  | PaddleCredentials
  | StripeCredentials
  | FakeCredentials;

type CredentialsOf<Code extends ProviderCode> = Extract<
  ProviderCredentials,
  { provider: Code }
>;

export { REDACTED, RedactedSecret };
export type {
  CredentialsOf,
  FakeCredentials,
  PaddleCredentials,
  PaddleEnvironment,
  ProviderCredentials,
  StripeCredentials,
};
