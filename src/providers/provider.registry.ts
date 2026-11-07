import { Injectable } from '@nestjs/common';

import { FakeProvider } from './fake/fake.provider';
import type { PaymentProvider, RefundIdentity } from './payment-provider.port';
import { isProviderCode, type ProviderCode } from './provider.constants';

@Injectable()
export class ProviderRegistry {
  private readonly providers: Record<ProviderCode, PaymentProvider>;

  constructor(fakeProvider: FakeProvider) {
    this.providers = { fake: fakeProvider };
  }

  get(code: ProviderCode): PaymentProvider {
    return this.providers[code];
  }

  find(code: string): PaymentProvider | null {
    return isProviderCode(code) ? this.providers[code] : null;
  }

  refundIdentityOf(code: ProviderCode): RefundIdentity {
    return this.get(code).capabilities.refundIdentity;
  }
}
