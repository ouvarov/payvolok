import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { raw } from 'express';
import helmet from 'helmet';

import type { Env } from './config/env.schema';

const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

const configureApp = (app: INestApplication): void => {
  const webOrigin = app
    .get<ConfigService<Env, true>>(ConfigService)
    .get('WEB_ORIGIN', { infer: true });

  app.use(helmet());
  // Behind the web app's rewrite the Origin is the web app's, not this API's Host.
  app.enableCsrfProtection({ trustedOrigins: [webOrigin] });
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
