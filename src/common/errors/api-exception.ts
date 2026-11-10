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

export class ApiException extends HttpException {
  constructor(readonly body: ApiErrorBody) {
    super(body, body.statusCode);
  }
}

export type { ApiErrorBody, ApiErrorIssue };
