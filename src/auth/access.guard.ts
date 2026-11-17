import {
  HttpStatus,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiException, type ApiErrorBody } from '@/common/errors/api-exception';
import { ProjectsService } from '@/projects/projects.service';

import type { ProjectAccessRequest } from './project-access-request';
import { RouteAccess, ROUTE_ACCESS_KEY } from './route-access.decorator';

const BEARER_TOKEN_PATTERN = /^Bearer (\S+)$/i;

const UNAUTHORIZED_BODY: ApiErrorBody = {
  statusCode: HttpStatus.UNAUTHORIZED,
  code: 'unauthorized',
  message: 'Invalid or missing API key',
};

@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly projectsService: ProjectsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (await this.isAllowed(context)) return true;

    throw new ApiException(UNAUTHORIZED_BODY);
  }

  private async isAllowed(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(
      ROUTE_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (access === undefined) {
      this.logger.error(
        `Route ${context.getClass().name}.${context.getHandler().name} declares no access`,
      );

      return false;
    }

    switch (access) {
      case 'public':
        return true;
      case 'project_key':
        return this.hasProjectKey(
          context.switchToHttp().getRequest<ProjectAccessRequest>(),
        );
      default:
        throw new Error(
          `Unhandled route access ${String(access satisfies never)}`,
        );
    }
  }

  private async hasProjectKey(request: ProjectAccessRequest): Promise<boolean> {
    const token = BEARER_TOKEN_PATTERN.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (token === undefined) return false;

    const projectAccess = await this.projectsService.findProjectAccess(token);
    if (!projectAccess) return false;

    request.projectAccess = projectAccess;

    return true;
  }
}
