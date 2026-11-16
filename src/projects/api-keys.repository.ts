import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from '@/database/drizzle';
import { apiKeys } from '@/database/schemas/api-keys.schema';
import { projects } from '@/database/schemas/projects.schema';

type ProjectAccess = { projectId: string; apiKeyId: string };

@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findActiveByHash(keyHash: string): Promise<ProjectAccess | null> {
    const [access] = await this.db
      .select({ projectId: apiKeys.projectId, apiKeyId: apiKeys.id })
      .from(apiKeys)
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .where(
        and(
          eq(apiKeys.keyHash, keyHash),
          isNull(apiKeys.revokedAt),
          sql`(${apiKeys.expiresAt} IS NULL OR ${apiKeys.expiresAt} > now())`,
          eq(projects.status, 'active'),
        ),
      );

    return access ?? null;
  }
}

export type { ProjectAccess };
