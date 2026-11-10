import {
  HttpStatus,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

import { ApiException, type ApiErrorBody } from '@/common/errors/api-exception';

import { IDEMPOTENT_REPLAYED_HEADER } from './idempotency.constants';
import type { IdempotentResponse } from './idempotency.service';

// A stored error goes through the exception filter; a success keeps the route's
// status, which an interceptor cannot change.
@Injectable()
export class IdempotentResponseInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler<IdempotentResponse>,
  ): Observable<object> {
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map(({ statusCode, body, isReplayed }) => {
        if (isReplayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        if (statusCode >= Number(HttpStatus.BAD_REQUEST)) {
          throw new ApiException(body as ApiErrorBody);
        }

        return body;
      }),
    );
  }
}
