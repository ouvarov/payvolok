import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import helmet from 'helmet';

import type { Env } from './config/env.schema';

const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

const configureApp = (app: NestExpressApplication): void => {
  const configService = app.get<ConfigService<Env, true>>(ConfigService);
  const webOrigin = configService.get('WEB_ORIGIN', { infer: true });

  // req.ip is then the address the last trusted proxy saw; the demo rate limit keys on it.
  app.set(
    'trust proxy',
    configService.get('TRUST_PROXY_HOPS', { infer: true }),
  );
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
