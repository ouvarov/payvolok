import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { IDEMPOTENCY_KEY_HEADER } from './idempotency.constants';
import { IdempotencyKeyPipe } from './idempotency-key.pipe';

const idempotencyKeyHeader = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER),
);

// Nest's @Headers() takes no pipes.
const IdempotencyKey = (): ParameterDecorator =>
  idempotencyKeyHeader(IdempotencyKeyPipe);

export { IdempotencyKey };
