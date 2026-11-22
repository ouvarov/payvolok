import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

const BEARER_TOKEN_PATTERN = /^Bearer (\S+)$/i;

const DemoToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    BEARER_TOKEN_PATTERN.exec(
      context.switchToHttp().getRequest<Request>().header('authorization') ??
        '',
    )?.[1],
);

export { DemoToken };
