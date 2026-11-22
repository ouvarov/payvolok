import { HttpException } from '@nestjs/common';

type ApiErrorIssue = {
  field: string;
  messages: string[];
};

type ApiErrorBody = {
  statusCode: number;
  code: string;
  message: string;
  paymentId?: string;
  issues?: ApiErrorIssue[];
};

type ApiExceptionOptions = { retryAfterSeconds?: number };

export class ApiException extends HttpException {
  readonly retryAfterSeconds: number | null;

  constructor(
    readonly body: ApiErrorBody,
    { retryAfterSeconds }: ApiExceptionOptions = {},
  ) {
    super(body, body.statusCode);
    this.retryAfterSeconds = retryAfterSeconds ?? null;
  }
}

export type { ApiErrorBody, ApiErrorIssue, ApiExceptionOptions };
