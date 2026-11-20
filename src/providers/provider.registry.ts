import { Injectable } from '@nestjs/common';

import { boundProviderOf } from './bound-provider';
import { FakeProvider } from './fake/fake.provider';
import { PaddleProvider } from './paddle/paddle.provider';
import {
  ProviderError,
  type BoundProvider,
  type PaymentProvider,
} from './payment-provider.port';
import type {
  CredentialsOf,
  ProviderCredentials,
} from './provider-credentials';
import type { ProviderCode } from './provider.constants';
import { StripeProvider } from './stripe/stripe.provider';

type ProviderAdapters = {
  [Code in ProviderCode]: PaymentProvider<CredentialsOf<Code>>;
};

type BindableAccount = {
  id: string;
  projectId: string;
  provider: ProviderCode;
};

@Injectable()
export class ProviderRegistry {
  private readonly adapters: ProviderAdapters;

  constructor(
    fakeProvider: FakeProvider,
    paddleProvider: PaddleProvider,
    stripeProvider: StripeProvider,
  ) {
    this.adapters = {
      fake: fakeProvider,
      paddle: paddleProvider,
      stripe: stripeProvider,
    };
  }

  bind(
    account: BindableAccount,
    credentials: ProviderCredentials,
  ): BoundProvider {
    if (credentials.provider !== account.provider) {
      throw new ProviderError(
        `provider account ${account.id} has credentials of another provider`,
        { providerCode: account.provider, kind: 'misconfigured' },
      );
    }

    switch (credentials.provider) {
      case 'fake':
        return boundProviderOf(account, this.adapters.fake, credentials);
      case 'paddle':
        return boundProviderOf(account, this.adapters.paddle, credentials);
      case 'stripe':
        return boundProviderOf(account, this.adapters.stripe, credentials);
    }
  }
}

export type { BindableAccount };
