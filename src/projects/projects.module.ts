import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';

import { ApiKeysRepository } from './api-keys.repository';
import { ProjectsRepository } from './projects.repository';
import { ProjectsService } from './projects.service';

@Module({
  imports: [DatabaseModule],
  providers: [ApiKeysRepository, ProjectsRepository, ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
