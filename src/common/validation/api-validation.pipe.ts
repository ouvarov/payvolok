import { HttpStatus, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import { ApiException } from '@/common/errors/api-exception';

const validationFailedException = (errors: ValidationError[]): ApiException =>
  new ApiException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: 'validation_failed',
    message: 'Request validation failed',
    issues: errors.map((error) => ({
      field: error.property,
      messages: Object.values(error.constraints ?? {}),
    })),
  });

// Nest defaults forbidUnknownValues to false, which lets an unknown object through.
const createApiValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    exceptionFactory: validationFailedException,
  });

export { createApiValidationPipe };
