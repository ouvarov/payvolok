import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { ProjectAccessRequest } from './project-access-request';

const CurrentProject = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const { projectAccess } = context
      .switchToHttp()
      .getRequest<ProjectAccessRequest>();
    if (!projectAccess) {
      throw new Error(
        `${context.getClass().name}.${context.getHandler().name} reads the project but its route access is not project_key`,
      );
    }

    return projectAccess.projectId;
  },
);

export { CurrentProject };
