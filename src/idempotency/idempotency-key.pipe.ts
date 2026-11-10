import { HttpStatus, Injectable, type PipeTransform } from '@nestjs/common';

import { ApiException } from '@/common/errors/api-exception';

import { IDEMPOTENCY_KEY_PATTERN } from './idempotency.constants';

@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<
  string | undefined,
  string
> {
  transform(idempotencyKey: string | undefined): string {
    if (idempotencyKey === undefined) {
      throw new ApiException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'idempotency_key_required',
        message: 'Idempotency-Key header is required',
      });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new ApiException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'idempotency_key_invalid',
        message:
          'Idempotency-Key must be 1 to 255 printable ASCII characters without spaces',
      });
    }

    return idempotencyKey;
  }
}
