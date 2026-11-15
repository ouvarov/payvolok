import type { ProviderCode } from '@/providers/provider.constants';

import type { ProviderCredentials } from './provider-credentials';

type CredentialedAccount = {
  id: string;
  provider: ProviderCode;
  credentialsRef: string;
};

// A token, not a class to inject directly: stored credentials replace the env resolver later.
export abstract class ProviderCredentialsResolver {
  abstract resolve(account: CredentialedAccount): Promise<ProviderCredentials>;
}

export type { CredentialedAccount };
