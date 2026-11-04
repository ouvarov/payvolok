import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { Env } from '@/config/env.schema';

import { DRIZZLE } from './drizzle';

const DATABASE_POOL = Symbol('DATABASE_POOL');
const CONNECT_TIMEOUT_SECONDS = 5;
const SHUTDOWN_TIMEOUT_SECONDS = 5;

@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (configService: ConfigService<Env, true>) =>
        postgres(configService.get('DATABASE_URL', { infer: true }), {
          prepare: false,
          max: configService.get('DATABASE_POOL_MAX', { infer: true }),
          connect_timeout: CONNECT_TIMEOUT_SECONDS,
        }),
      inject: [ConfigService],
    },
    {
      provide: DRIZZLE,
      useFactory: (sqlClient: postgres.Sql) => drizzle(sqlClient),
      inject: [DATABASE_POOL],
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_POOL) private readonly sqlClient: postgres.Sql,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sqlClient.end({ timeout: SHUTDOWN_TIMEOUT_SECONDS });
  }
}
