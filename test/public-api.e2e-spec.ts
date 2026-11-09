import { createHash, randomUUID } from 'node:crypto';

import {
  Controller,
  Get,
  Logger,
  type INestApplication,
  type LogLevel,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import request from 'supertest';

import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import { payments, type Payment } from '@/database/schemas/payments.schema';
import { PaymentsRepository } from '@/payments/payments.repository';
import { FakeProvider } from '@/providers/fake/fake.provider';

import { createE2eApp, serverOf, TEST_API_KEY } from './helpers';

const SIGNATURE_HEADER = 'x-fake-signature';
const LEAK_MARKER = 'LEAKMARKER';
const VALID_AUTHORIZATION = `Bearer ${TEST_API_KEY}`;
const UNAUTHORIZED_BODY = {
  statusCode: 401,
  code: 'unauthorized',
  message: 'Invalid or missing API key',
};
const NOT_FOUND_BODY = {
  statusCode: 404,
  code: 'not_found',
  message: 'Not found',
};
const BAD_REQUEST_BODY = {
  statusCode: 400,
  code: 'bad_request',
  message: 'Bad request',
};
const OVER_JSON_BODY_LIMIT_BYTES = 101 * 1024;
const LOG_LEVELS: LogLevel[] = ['log', 'warn', 'error', 'debug', 'verbose'];
const TABLES_WITH_REQUEST_DATA = [
  'payments',
  'payment_events',
  'refunds',
  'webhook_events',
];

const undeclaredHandlerRan = jest.fn();

@Controller(`${API_V1_PREFIX}/undeclared`)
class UndeclaredApiController {
  @Get()
  handle(): { isHandled: boolean } {
    undeclaredHandlerRan();

    return { isHandled: true };
  }
}

@Controller('undeclared-outside-api')
class UndeclaredOutsideApiController {
  @Get()
  handle(): { isHandled: boolean } {
    undeclaredHandlerRan();

    return { isHandled: true };
  }
}

describe('Public API', () => {
  let app: INestApplication;
  let db: Database;
  let fakeProvider: FakeProvider;

  const get = (path: string, authorization?: string) => {
    const call = request(serverOf(app)).get(path);

    return authorization === undefined
      ? call
      : call.set('Authorization', authorization);
  };

  const paymentPath = (paymentId: string): string =>
    `/${API_V1_PREFIX}/payments/${paymentId}`;

  const insertPayment = async (): Promise<Payment> => {
    const [payment] = await db
      .insert(payments)
      .values({
        provider: 'fake',
        providerPaymentId: randomUUID(),
        purpose: 'one_off',
        origin: 'api',
        status: 'pending',
        amountMinor: 1000,
        currency: 'USD',
      })
      .returning();

    return payment;
  };

  const deliverSignedWebhook = (authorization?: string) => {
    const rawBody = Buffer.from(
      JSON.stringify({
        eventId: randomUUID(),
        occurredAt: null,
        events: [
          {
            type: 'subscription.canceled',
            reference: null,
            providerSubscriptionId: randomUUID(),
            providerStatus: 'canceled',
            currentPeriodEnd: null,
          },
        ],
      }),
    );
    const signature = fakeProvider.signRawBody(rawBody).headers[
      SIGNATURE_HEADER
    ] as string;
    const call = request(serverOf(app))
      .post('/webhooks/fake')
      .set('Content-Type', 'application/octet-stream')
      .set(SIGNATURE_HEADER, signature);

    return (
      authorization === undefined
        ? call
        : call.set('Authorization', authorization)
    ).send(rawBody.toString());
  };

  const captureLogs = () => {
    const spies = LOG_LEVELS.map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(),
    );

    return (): string => JSON.stringify(spies.map((spy) => spy.mock.calls));
  };

  beforeAll(async () => {
    app = await createE2eApp({
      extraControllers: [
        UndeclaredApiController,
        UndeclaredOutsideApiController,
      ],
    });
    db = app.get<Database>(DRIZZLE);
    fakeProvider = app.get(FakeProvider);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('public routes', () => {
    it.each(['/health/live', '/health/ready'])(
      'answers %s with no key',
      async (path) => {
        const response = await get(path).expect(200);

        expect(response.body).toEqual({ status: 'ok' });
      },
    );

    it('accepts a signed webhook with no key', async () => {
      const response = await deliverSignedWebhook().expect(200);

      expect(response.body).toEqual({ received: true });
    });
  });

  describe('a route that declares no access', () => {
    it.each([
      ['no key', undefined],
      ['a valid key', VALID_AUTHORIZATION],
    ])('answers 401 with %s and never runs', async (_case, authorization) => {
      const logs = captureLogs();

      const response = await get(
        `/${API_V1_PREFIX}/undeclared`,
        authorization,
      ).expect(401);

      expect(response.body).toEqual(UNAUTHORIZED_BODY);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(undeclaredHandlerRan).not.toHaveBeenCalled();
      expect(logs()).toContain('UndeclaredApiController.handle');
    });

    it('is refused outside /api as well, even with a valid key', async () => {
      const logs = captureLogs();

      await get('/undeclared-outside-api', VALID_AUTHORIZATION).expect(401);

      expect(undeclaredHandlerRan).not.toHaveBeenCalled();
      expect(logs()).toContain('UndeclaredOutsideApiController.handle');
    });
  });

  describe('API key', () => {
    it.each([
      ['a missing header', undefined],
      ['the wrong scheme', `Basic ${TEST_API_KEY}`],
      [
        'a wrong key of the same length',
        `Bearer ${'x'.repeat(TEST_API_KEY.length)}`,
      ],
      ['a wrong key of another length', 'Bearer short'],
      ['an empty token', 'Bearer '],
      ['the key with no scheme', TEST_API_KEY],
    ])('answers the uniform 401 for %s', async (_case, authorization) => {
      const response = await get(
        paymentPath(randomUUID()),
        authorization,
      ).expect(401);

      expect(response.body).toEqual(UNAUTHORIZED_BODY);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    it('answers 401 before validating the id', async () => {
      const response = await get(paymentPath('not-a-uuid')).expect(401);

      expect(response.body).toEqual(UNAUTHORIZED_BODY);
    });

    it('accepts the scheme in any case', async () => {
      const payment = await insertPayment();

      await get(paymentPath(payment.id), `bearer ${TEST_API_KEY}`).expect(200);
    });

    it('answers the uniform 401 on an upper-case /API path', async () => {
      const response = await get(`/API/V1/payments/${randomUUID()}`).expect(
        401,
      );

      expect(response.body).toEqual(UNAUTHORIZED_BODY);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });
  });

  describe('GET /api/v1/payments/:id', () => {
    it('returns exactly the public fields and calls no provider', async () => {
      const providerCalls = [
        jest.spyOn(FakeProvider.prototype, 'createPayment'),
        jest.spyOn(FakeProvider.prototype, 'refund'),
        jest.spyOn(FakeProvider.prototype, 'getStatus'),
      ];
      const payment = await insertPayment();

      const response = await get(
        paymentPath(payment.id),
        VALID_AUTHORIZATION,
      ).expect(200);

      expect(response.body).toEqual({
        paymentId: payment.id,
        status: 'pending',
        provider: 'fake',
        amountMinor: 1000,
        currency: 'USD',
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
      });
      for (const providerCall of providerCalls) {
        expect(providerCall).not.toHaveBeenCalled();
      }
    });

    it('answers 404 payment_not_found for an unknown id', async () => {
      const response = await get(
        paymentPath(randomUUID()),
        VALID_AUTHORIZATION,
      ).expect(404);

      expect(response.body).toEqual({
        statusCode: 404,
        code: 'payment_not_found',
        message: 'Payment not found',
      });
    });

    it('answers 400 bad_request for an id that is not a uuid', async () => {
      const response = await get(
        paymentPath(LEAK_MARKER),
        VALID_AUTHORIZATION,
      ).expect(400);

      expect(response.body).toEqual(BAD_REQUEST_BODY);
      expect(response.text).not.toContain(LEAK_MARKER);
    });
  });

  describe('routing and body errors', () => {
    it('keeps health outside the versioned prefix', async () => {
      const response = await get(`/${API_V1_PREFIX}/health`).expect(404);

      expect(response.body).toEqual(NOT_FOUND_BODY);
      await get('/health/live').expect(200);
    });

    it('answers the uniform 404 for an unknown route, echoing nothing', async () => {
      const response = await get(`/${API_V1_PREFIX}/${LEAK_MARKER}`).expect(
        404,
      );

      expect(response.body).toEqual(NOT_FOUND_BODY);
      expect(response.text).not.toContain(LEAK_MARKER);
    });

    it('answers the uniform 400 for malformed JSON, echoing nothing', async () => {
      const response = await request(serverOf(app))
        .post(`/${API_V1_PREFIX}/nope`)
        .set('Content-Type', 'application/json')
        .send(`{"${LEAK_MARKER}":`)
        .expect(400);

      expect(response.body).toEqual(BAD_REQUEST_BODY);
      expect(response.text).not.toContain(LEAK_MARKER);
    });

    it('answers the uniform 400 for a broken percent escape in the path', async () => {
      const response = await get(
        `/${API_V1_PREFIX}/payments/%E0%A4%A`,
        VALID_AUTHORIZATION,
      ).expect(400);

      expect(response.body).toEqual(BAD_REQUEST_BODY);
    });

    it('answers the uniform 413 for an oversized body', async () => {
      const response = await request(serverOf(app))
        .post(`/${API_V1_PREFIX}/nope`)
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({ padding: 'x'.repeat(OVER_JSON_BODY_LIMIT_BYTES) }),
        )
        .expect(413);

      expect(response.body).toEqual({
        statusCode: 413,
        code: 'payload_too_large',
        message: 'Payload too large',
      });
    });
  });

  describe('an unexpected error', () => {
    it('answers 500 internal_error and logs only the class and the pg code', async () => {
      const logs = captureLogs();
      const secret = 'postgres://user:SECRETVALUE@internal-host/db';
      jest.spyOn(PaymentsRepository.prototype, 'findById').mockRejectedValue(
        Object.assign(new Error(`query failed: ${secret}`), {
          cause: { code: '42P01', message: secret },
        }),
      );

      const response = await get(
        paymentPath(randomUUID()),
        VALID_AUTHORIZATION,
      ).expect(500);

      expect(response.body).toEqual({
        statusCode: 500,
        code: 'internal_error',
        message: 'Internal server error',
      });
      expect(response.text).not.toContain('SECRETVALUE');
      expect(logs()).toContain('Error 42P01');
      expect(logs()).not.toMatch(/SECRETVALUE|internal-host|query failed/);
    });
  });

  describe('the plaintext key', () => {
    const rowsHoldingTheKey = async (table: string): Promise<number> => {
      const [{ matching_rows: matchingRows }] = await db.execute<{
        matching_rows: number;
      }>(sql`
        select count(*)::int as matching_rows
        from ${sql.identifier(table)} as candidate
        where candidate::text like ${`%${TEST_API_KEY}%`}
      `);

      return matchingRows;
    };

    it('is not in the environment and only its hash is configured', () => {
      const configuredDigest = app
        .get(ConfigService)
        .get<string>('API_KEY_SHA256');

      expect(configuredDigest).toBe(
        createHash('sha256').update(TEST_API_KEY).digest('hex'),
      );
      expect(Object.values(process.env).join('\n')).not.toContain(TEST_API_KEY);
    });

    it('is in no log and no database row after being sent everywhere', async () => {
      const logs = captureLogs();
      const payment = await insertPayment();

      await get(paymentPath(payment.id), VALID_AUTHORIZATION).expect(200);
      await get(`/${API_V1_PREFIX}/undeclared`, VALID_AUTHORIZATION).expect(
        401,
      );
      await deliverSignedWebhook(VALID_AUTHORIZATION).expect(200);

      expect(logs()).not.toContain(TEST_API_KEY);
      for (const table of TABLES_WITH_REQUEST_DATA) {
        expect(await rowsHoldingTheKey(table)).toBe(0);
      }
    });
  });
});
