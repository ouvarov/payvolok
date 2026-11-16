import { parseArgs } from 'node:util';

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { envSchema } from '../config/env.schema';
import type { Database } from '../database/drizzle';
import { apiKeys } from '../database/schemas/api-keys.schema';
import { projects } from '../database/schemas/projects.schema';

import { apiKeyHashOf, apiKeyPrefixOf, generateApiKey } from './api-key';

type ApiKeyRequest = {
  projectSlug: string;
  name: string;
  expiresInDays: number | null;
};

type CreatedApiKey = { apiKeyId: string; projectId: string; apiKey: string };

const expiresInDaysOf = (value: string | undefined): number | null => {
  if (value === undefined) return null;

  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(
      '--expires-in-days must be a whole number of days, 1 or more',
    );
  }

  return days;
};

const requestOf = (args: string[]): ApiKeyRequest => {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      name: { type: 'string' },
      'expires-in-days': { type: 'string' },
    },
  });
  if (!values.project || !values.name) {
    throw new Error(
      'Usage: --project <slug> --name <label> [--expires-in-days N]',
    );
  }

  return {
    projectSlug: values.project,
    name: values.name,
    expiresInDays: expiresInDaysOf(values['expires-in-days']),
  };
};

const createApiKey = async (
  db: Database,
  request: ApiKeyRequest,
): Promise<CreatedApiKey> => {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, request.projectSlug));
  if (!project) throw new Error(`No project with slug ${request.projectSlug}`);

  const apiKey = generateApiKey();
  const [created] = await db
    .insert(apiKeys)
    .values({
      projectId: project.id,
      name: request.name,
      keyHash: apiKeyHashOf(apiKey),
      keyPrefix: apiKeyPrefixOf(apiKey),
      expiresAt:
        request.expiresInDays === null
          ? null
          : sql`clock_timestamp() + ${request.expiresInDays}::integer * interval '1 day'`,
    })
    .returning({ id: apiKeys.id });

  return { apiKeyId: created.id, projectId: project.id, apiKey };
};

const runCreateApiKey = async (): Promise<void> => {
  const { DATABASE_URL } = envSchema
    .pick({ DATABASE_URL: true })
    .parse(process.env);
  const request = requestOf(process.argv.slice(2));
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

  try {
    console.log(
      `Creating an API key for project ${request.projectSlug} on ${new URL(DATABASE_URL).hostname}`,
    );
    const created = await createApiKey(drizzle(client), request);
    console.log(`API key ${created.apiKeyId} created. It is shown only once:`);
    console.log(created.apiKey);
  } finally {
    await client.end();
  }
};

if (require.main === module) {
  runCreateApiKey().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { createApiKey, requestOf };
export type { ApiKeyRequest, CreatedApiKey };
