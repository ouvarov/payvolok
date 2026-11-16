import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type Database } from '@/database/drizzle';
import { projects } from '@/database/schemas/projects.schema';

@Injectable()
export class ProjectsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findAllowedReturnOrigins(projectId: string): Promise<string[] | null> {
    const [project] = await this.db
      .select({ allowedReturnOrigins: projects.allowedReturnOrigins })
      .from(projects)
      .where(eq(projects.id, projectId));

    return project?.allowedReturnOrigins ?? null;
  }
}
