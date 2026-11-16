import { randomBytes, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';

import { DRIZZLE, type Database } from '@/database/drizzle';
import { projects } from '@/database/schemas/projects.schema';
import { providerAccounts } from '@/database/schemas/provider-accounts.schema';
import { EnvCredentialsResolver } from '@/provider-accounts/env-credentials.resolver';
import { ProviderCredentialsResolver } from '@/provider-accounts/provider-credentials.resolver';
import { FakeProvider } from '@/providers/fake/fake.provider';
import {
  RedactedSecret,
  type ProviderCredentials,
} from '@/providers/provider-credentials';

import { fakeSignerFor, type ClassOverride, type FakeSigner } from './helpers';

const FAKE_A_CREDENTIALS_REF = 'env:FAKE_A';
const FAKE_B_CREDENTIALS_REF = 'env:FAKE_B';
const SLUG_SUFFIX_BYTES = 4;
const SECRET_BYTES = 32;

type TestAccount = {
  projectId: string;
  accountId: string;
  credentialsRef: string;
  signer: FakeSigner;
};

type TwoProjectsFixture = { a: TestAccount; b: TestAccount };

type TwoProjects = {
  override: ClassOverride;
  // A ref in this set resolves to no credentials, as a broken account would.
  failingRefs: Set<string>;
  create: (app: INestApplication) => Promise<TwoProjectsFixture>;
};

const newSecret = (): RedactedSecret =>
  new RedactedSecret(randomBytes(SECRET_BYTES).toString('hex'));

const createAccount = async (
  app: INestApplication,
  label: string,
  credentialsRef: string,
  secret: RedactedSecret,
): Promise<TestAccount> => {
  const db = app.get<Database>(DRIZZLE);
  const projectId = randomUUID();
  const accountId = randomUUID();
  const suffix = randomBytes(SLUG_SUFFIX_BYTES).toString('hex');

  await db.insert(projects).values({
    id: projectId,
    slug: `project-${label}-${suffix}`,
    name: `Project ${label.toUpperCase()}`,
  });
  await db.insert(providerAccounts).values({
    id: accountId,
    projectId,
    provider: 'fake',
    credentialsRef,
  });

  return {
    projectId,
    accountId,
    credentialsRef,
    signer: fakeSignerFor(secret, app.get(FakeProvider), {
      id: accountId,
      projectId,
    }),
  };
};

// The API still writes to the seed project in 3.5b, so project B's rows are inserted directly.
const twoProjects = (): TwoProjects => {
  const secretsByRef = new Map<string, RedactedSecret>([
    [FAKE_A_CREDENTIALS_REF, newSecret()],
    [FAKE_B_CREDENTIALS_REF, newSecret()],
  ]);
  const failingRefs = new Set<string>();

  class TestCredentialsResolver extends EnvCredentialsResolver {
    protected override credentialsFor(
      credentialsRef: string,
    ): ProviderCredentials | null {
      if (failingRefs.has(credentialsRef)) return null;

      const secret = secretsByRef.get(credentialsRef);
      if (!secret) return super.credentialsFor(credentialsRef);

      return { provider: 'fake', webhookSecrets: [secret] };
    }
  }

  const secretOf = (credentialsRef: string): RedactedSecret => {
    const secret = secretsByRef.get(credentialsRef);
    if (!secret) throw new Error(`No test secret for ${credentialsRef}`);

    return secret;
  };

  return {
    override: {
      provide: ProviderCredentialsResolver,
      useClass: TestCredentialsResolver,
    },
    failingRefs,
    create: async (app) => ({
      a: await createAccount(
        app,
        'a',
        FAKE_A_CREDENTIALS_REF,
        secretOf(FAKE_A_CREDENTIALS_REF),
      ),
      b: await createAccount(
        app,
        'b',
        FAKE_B_CREDENTIALS_REF,
        secretOf(FAKE_B_CREDENTIALS_REF),
      ),
    }),
  };
};

export { FAKE_A_CREDENTIALS_REF, FAKE_B_CREDENTIALS_REF, twoProjects };
export type { TestAccount, TwoProjectsFixture };
