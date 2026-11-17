import { Injectable } from '@nestjs/common';

import { API_KEY_PATTERN, apiKeyHashOf } from './api-key';
import { ApiKeysRepository, type ProjectAccess } from './api-keys.repository';
import { ProjectsRepository } from './projects.repository';
import { isReturnOriginAllowed } from './return-origin';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly apiKeysRepository: ApiKeysRepository,
    private readonly projectsRepository: ProjectsRepository,
  ) {}

  // No timingSafeEqual: the lookup goes through the index of a 256-bit hash, not a compare of the key.
  async findProjectAccess(apiKey: string): Promise<ProjectAccess | null> {
    if (!API_KEY_PATTERN.test(apiKey)) return null;

    return this.apiKeysRepository.findActiveByHash(apiKeyHashOf(apiKey));
  }

  async isReturnUrlAllowed(
    projectId: string,
    returnUrl: string,
  ): Promise<boolean> {
    const allowedOrigins =
      await this.projectsRepository.findAllowedReturnOrigins(projectId);
    if (!allowedOrigins) return false;

    return isReturnOriginAllowed(returnUrl, allowedOrigins);
  }
}

export type { ProjectAccess };
