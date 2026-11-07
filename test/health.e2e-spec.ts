import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createE2eApp, databaseUrl, serverOf } from './helpers';

const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/none';
const HEALTH_POOL_MAX = 1;

describe('Health routes', () => {
  let healthyApp: INestApplication;
  let brokenApp: INestApplication;

  beforeAll(async () => {
    healthyApp = await createE2eApp({
      appDatabaseUrl: databaseUrl,
      appDatabasePoolMax: HEALTH_POOL_MAX,
    });
    brokenApp = await createE2eApp({
      appDatabaseUrl: UNREACHABLE_DATABASE_URL,
      appDatabasePoolMax: HEALTH_POOL_MAX,
    });
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
