import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import type { Env } from '@/config/env.schema';

describe('AppModule environment validation', () => {
  it('passes the environment through the zod schema', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const configService =
      moduleRef.get<ConfigService<Env, true>>(ConfigService);

    expect(configService.get('DATABASE_POOL_MAX', { infer: true })).toEqual(
      expect.any(Number),
    );
    expect(configService.get('PORT', { infer: true })).toEqual(
      expect.any(Number),
    );

    await moduleRef.close();
  });
});
