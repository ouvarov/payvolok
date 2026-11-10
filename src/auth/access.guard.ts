import { createHash, timingSafeEqual } from 'node:crypto';

import {
  HttpStatus,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ApiException, type ApiErrorBody } from '@/common/errors/api-exception';
import type { Env } from '@/config/env.schema';

import { RouteAccess, ROUTE_ACCESS_KEY } from './route-access.decorator';

const BEARER_TOKEN_PATTERN = /^Bearer (\S+)$/i;

const UNAUTHORIZED_BODY: ApiErrorBody = {
  statusCode: HttpStatus.UNAUTHORIZED,
  code: 'unauthorized',
  message: 'Invalid or missing API key',
};

const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);
  private readonly expectedKeyDigest: Buffer;

  constructor(
    private readonly reflector: Reflector,
    configService: ConfigService<Env, true>,
  ) {
    this.expectedKeyDigest = Buffer.from(
      configService.get('API_KEY_SHA256', { infer: true }),
      'hex',
    );
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.isAllowed(context)) return true;

    throw new ApiException(UNAUTHORIZED_BODY);
  }

  private isAllowed(context: ExecutionContext): boolean {
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
      case 'api_key':
        return this.hasValidApiKey(context.switchToHttp().getRequest());
      default:
        throw new Error(
          `Unhandled route access ${String(access satisfies never)}`,
        );
    }
  }

  // Both sides are SHA-256 digests, so the compare never branches on key length.
  private hasValidApiKey(request: Request): boolean {
    const token = BEARER_TOKEN_PATTERN.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (token === undefined) return false;

    return timingSafeEqual(sha256(token), this.expectedKeyDigest);
  }
}
