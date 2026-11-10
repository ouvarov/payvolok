import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';

import { ApiException, type ApiErrorBody } from '@/common/errors/api-exception';
import { describeError } from '@/database/postgres-errors';

// Express routes case-insensitively, so /API/v1 reaches the same handlers.
const API_PATH_PATTERN = /^\/api\//i;

type GenericError = Pick<ApiErrorBody, 'code' | 'message'>;

const GENERIC_ERROR_BY_STATUS: Readonly<Record<number, GenericError>> = {
  [HttpStatus.BAD_REQUEST]: { code: 'bad_request', message: 'Bad request' },
  [HttpStatus.UNAUTHORIZED]: { code: 'unauthorized', message: 'Unauthorized' },
  [HttpStatus.NOT_FOUND]: { code: 'not_found', message: 'Not found' },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    code: 'payload_too_large',
    message: 'Payload too large',
  },
};
const FALLBACK_GENERIC_ERROR: GenericError = {
  code: 'http_error',
  message: 'Request failed',
};
const INTERNAL_ERROR_BODY: ApiErrorBody = {
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  code: 'internal_error',
  message: 'Internal server error',
};

@Catch()
export class ApiExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    // Not originalUrl: it keeps the scheme and host of an absolute-form request.
    if (!API_PATH_PATTERN.test(http.getRequest<Request>().path)) {
      super.catch(exception, host);
      return;
    }

    const body = this.toApiErrorBody(exception);
    const response = http.getResponse<Response>();
    if (response.headersSent) {
      response.end();
      return;
    }

    if (body.statusCode === Number(HttpStatus.UNAUTHORIZED)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }
    response.status(body.statusCode).json(body);
  }

  private toApiErrorBody(exception: unknown): ApiErrorBody {
    if (exception instanceof ApiException) return exception.body;

    // Never Nest's own text: for a body-parser failure it quotes the request.
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();

      return {
        statusCode,
        ...(GENERIC_ERROR_BY_STATUS[statusCode] ?? FALLBACK_GENERIC_ERROR),
      };
    }

    this.logger.error(`Unhandled API error: ${describeError(exception)}`);

    return INTERNAL_ERROR_BODY;
  }
}
