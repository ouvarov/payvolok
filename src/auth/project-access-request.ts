import type { Request } from 'express';

import type { ProjectAccess } from '@/projects/projects.service';

type ProjectAccessRequest = Request & { projectAccess?: ProjectAccess };

export type { ProjectAccessRequest };
