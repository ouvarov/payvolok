import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';

const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/none';

const serverOf = (app: INestApplication): Server =>
  app.getHttpServer() as Server;

const createApp = async (databaseUrl: string): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue({
      get: (key: 'DATABASE_URL' | 'DATABASE_POOL_MAX') =>
        ({ DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: 1 })[key],
    })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
};

describe('Health routes', () => {
  let healthyApp: INestApplication;
  let brokenApp: INestApplication;

  beforeAll(async () => {
    healthyApp = await createApp(process.env.E2E_DATABASE_URL as string);
    brokenApp = await createApp(UNREACHABLE_DATABASE_URL);
  });

  afterAll(async () => {
    await healthyApp.close();
    await brokenApp.close();
  });

  it('GET /health/live returns 200 when the database is reachable', async () => {
    const response = await request(serverOf(healthyApp))
      .get('/health/live')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/live returns 200 when the database is down', async () => {
    const response = await request(serverOf(brokenApp))
      .get('/health/live')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 200 when the database answers', async () => {
    const response = await request(serverOf(healthyApp))
      .get('/health/ready')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 503 without connection details when the database is unreachable', async () => {
    const response = await request(serverOf(brokenApp))
      .get('/health/ready')
      .expect(503);

    expect(response.body).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(response.body)).not.toMatch(/127\.0\.0\.1|nobody/);
  });
});
