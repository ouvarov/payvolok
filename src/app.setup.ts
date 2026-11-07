import type { INestApplication } from '@nestjs/common';
import { raw } from 'express';

const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

const configureApp = (app: INestApplication): void => {
  // Signatures cover the exact bytes, so nothing may parse or inflate them first.
  app.use(
    '/webhooks',
    raw({
      type: () => true,
      limit: WEBHOOK_BODY_LIMIT_BYTES,
      inflate: false,
    }),
  );
};

export { configureApp, WEBHOOK_BODY_LIMIT_BYTES };
