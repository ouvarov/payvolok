import { randomInt, randomUUID } from 'node:crypto';

import {
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';

import { RouteAccess } from '@/auth/route-access.decorator';
import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import { idempotencyKeys } from '@/database/schemas/idempotency-keys.schema';
import { payments } from '@/database/schemas/payments.schema';

import { createE2eApp, deliverTo, serverOf, TEST_API_KEY } from './helpers';

const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const RATE_LIMITED_PATH = `/${API_V1_PREFIX}/rate-limited`;
const WEB_ORIGIN = 'https://web.payvolok.e2e.test';
const FORBIDDEN_BODY = {
  statusCode: 403,
  code: 'forbidden',
  message: 'Forbidden',
};
const UNAUTHORIZED_BODY = {
  statusCode: 401,
  code: 'unauthorized',
  message: 'Invalid or missing API key',
};

@RouteAccess('public')
@Controller(`${API_V1_PREFIX}/rate-limited`)
class RateLimitedController {
  @Post()
  handle(): never {
    throw new HttpException(
      'quota of 5 per hour used',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

const expectHardenedHeaders = (response: Response): void => {
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['content-security-policy']).toEqual(
    expect.stringContaining("default-src 'self'"),
  );
  expect(response.headers).not.toHaveProperty('x-powered-by');
};

describe('HTTP security', () => {
  let app: INestApplication;
  let db: Database;

  const postPayment = () => request(serverOf(app)).post(PAYMENTS_PATH);

  const paymentBody = (amountMinor: number) => ({
    provider: 'fake',
    amountMinor,
    currency: 'USD',
    description: 'cross-site order',
    returnUrl: 'https://shop.example.test/return',
  });

  beforeAll(async () => {
    app = await createE2eApp({ extraControllers: [RateLimitedController] });
    db = app.get<Database>(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('security headers', () => {
    it.each([
      ['an /api/v1 route', () => request(serverOf(app)).get(PAYMENTS_PATH)],
      ['a /health route', () => request(serverOf(app)).get('/health/live')],
      [
        'a /webhooks route',
        () => deliverTo(app, Buffer.from(randomUUID()), 'not-a-signature'),
      ],
    ])(
      'sets nosniff and a CSP and hides X-Powered-By on %s',
      async (_case, call) => {
        expectHardenedHeaders(await call());
      },
    );
  });

  describe('cross-origin protection', () => {
    it('answers a cross-site POST 403 forbidden and writes nothing, even with a valid key', async () => {
      const amountMinor = randomInt(10_000, 10_000_000) * 100 + 7;
      const idempotencyKey = `csrf-${randomUUID()}`;

      const response = await postPayment()
        .set('Sec-Fetch-Site', 'cross-site')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(paymentBody(amountMinor))
        .expect(403);

      expect(response.body).toEqual(FORBIDDEN_BODY);
      expectHardenedHeaders(response);
      expect(
        await db
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.amountMinor, amountMinor)),
      ).toEqual([]);
      expect(
        await db
          .select({ key: idempotencyKeys.key })
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, idempotencyKey)),
      ).toEqual([]);
    });

    it('warns once about a cross-site POST with its origin and sec-fetch-site, never its key', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await postPayment()
        .set('Sec-Fetch-Site', 'cross-site')
        .set('Origin', 'https://evil.test')
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .send(paymentBody(randomInt(10_000, 10_000_000) * 100))
        .expect(403);

      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain(`Forbidden POST ${PAYMENTS_PATH}`);
      expect(message).toContain('origin "https://evil.test"');
      expect(message).toContain('sec-fetch-site "cross-site"');
      expect(message).not.toContain(TEST_API_KEY);
      expect(message).not.toContain('cross-site order');
    });

    it('lets a same-origin POST reach the API key guard', async () => {
      const response = await postPayment()
        .set('Sec-Fetch-Site', 'same-origin')
        .send({})
        .expect(401);

      expect(response.body).toEqual(UNAUTHORIZED_BODY);
    });

    it('lets a POST from WEB_ORIGIN through when the browser sends only Origin', async () => {
      const response = await postPayment()
        .set('Origin', WEB_ORIGIN)
        .send({})
        .expect(401);

      expect(response.body).toEqual(UNAUTHORIZED_BODY);
    });

    it('answers a POST from another Origin 403 forbidden', async () => {
      const response = await postPayment()
        .set('Origin', 'https://evil.test')
        .send({})
        .expect(403);

      expect(response.body).toEqual(FORBIDDEN_BODY);
    });
  });

  it('answers a 429 from /api with the generic rate_limited body', async () => {
    const response = await request(serverOf(app))
      .post(RATE_LIMITED_PATH)
      .expect(429);

    expect(response.body).toEqual({
      statusCode: 429,
      code: 'rate_limited',
      message: 'Too many requests',
    });
  });
});
