import { randomBytes, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';

import { DRIZZLE, type Database } from '@/database/drizzle';
import { apiKeys } from '@/database/schemas/api-keys.schema';
import { projects } from '@/database/schemas/projects.schema';
import { providerAccounts } from '@/database/schemas/provider-accounts.schema';
import {
  apiKeyHashOf,
  apiKeyPrefixOf,
  generateApiKey,
} from '@/projects/api-key';
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
  apiKey: string;
  signer: FakeSigner;
};

type InsertedApiKey = { apiKeyId: string; apiKey: string };

const insertApiKey = async (
  db: Database,
  projectId: string,
): Promise<InsertedApiKey> => {
  const apiKey = generateApiKey();
  const [{ id }] = await db
    .insert(apiKeys)
    .values({
      projectId,
      name: 'e2e',
      keyHash: apiKeyHashOf(apiKey),
      keyPrefix: apiKeyPrefixOf(apiKey),
    })
    .returning({ id: apiKeys.id });

  return { apiKeyId: id, apiKey };
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
  const { apiKey } = await insertApiKey(db, projectId);

  return {
    projectId,
    accountId,
    credentialsRef,
    apiKey,
    signer: fakeSignerFor(secret, app.get(FakeProvider), {
      id: accountId,
      projectId,
    }),
  };
};

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

export {
  FAKE_A_CREDENTIALS_REF,
  FAKE_B_CREDENTIALS_REF,
  insertApiKey,
  twoProjects,
};
export type { InsertedApiKey, TestAccount, TwoProjectsFixture };
