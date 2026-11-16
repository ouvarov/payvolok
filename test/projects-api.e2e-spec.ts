import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  Controller,
  Get,
  Logger,
  type INestApplication,
  type LogLevel,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';

import { CurrentProject } from '@/auth/current-project.decorator';
import { RouteAccess } from '@/auth/route-access.decorator';
import { API_V1_PREFIX } from '@/common/api-prefix';
import { DRIZZLE, type Database } from '@/database/drizzle';
import { apiKeys } from '@/database/schemas/api-keys.schema';
import { idempotencyKeys } from '@/database/schemas/idempotency-keys.schema';
import { payments, type Payment } from '@/database/schemas/payments.schema';
import { projects } from '@/database/schemas/projects.schema';
import { refunds } from '@/database/schemas/refunds.schema';
import {
  IdempotencyRepository,
  type IdempotentRequest,
} from '@/idempotency/idempotency.repository';
import { API_KEY_PATTERN } from '@/projects/api-key';
import { createApiKey } from '@/projects/create-api-key';
import { FakeProvider } from '@/providers/fake/fake.provider';
import { encodeFakeId } from '@/providers/fake/fake-wire-format';

import { createE2eApp, databaseUrl, serverOf, TEST_API_KEY } from './helpers';
import { insertApiKey, twoProjects, type TestAccount } from './two-projects';

const PAYMENTS_PATH = `/${API_V1_PREFIX}/payments`;
const ECHO_PATH = `/${API_V1_PREFIX}/project-echo`;
const UNDECLARED_PATH = `/${API_V1_PREFIX}/project-undeclared`;
const SHOP_ORIGIN = 'https://shop.example';
const RETURN_URL = `${SHOP_ORIGIN}/return`;
const OLD_LOCAL_API_KEY = 'local-dev-api-key';
const OLD_E2E_API_KEY = 'e2e-test-api-key-with-enough-length-0001';
const SLUG_SUFFIX_BYTES = 4;
const LOG_LEVELS: LogLevel[] = ['log', 'warn', 'error', 'debug', 'verbose'];
const UNAUTHORIZED_BODY = {
  statusCode: 401,
  code: 'unauthorized',
  message: 'Invalid or missing API key',
};
const RETURN_URL_NOT_ALLOWED_BODY = {
  statusCode: 400,
  code: 'return_url_not_allowed',
  message: 'The returnUrl origin is not allowed for this project',
};

@RouteAccess('project_key')
@Controller(`${API_V1_PREFIX}/project-echo`)
class ProjectEchoController {
  @Get()
  echo(@CurrentProject() projectId: string): { projectId: string } {
    return { projectId };
  }
}

@Controller(`${API_V1_PREFIX}/project-undeclared`)
class ProjectUndeclaredController {
  @Get()
  handle(): { isHandled: boolean } {
    return { isHandled: true };
  }
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const uniqueAmountMinor = (): number => randomInt(10_000, 10_000_000) * 100;

const newKey = (): string => `e2e-${randomUUID()}`;

const captureLogs = () => {
  const spies = LOG_LEVELS.map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(),
  );

  return (): string => JSON.stringify(spies.map((spy) => spy.mock.calls));
};

describe('projects in the API', () => {
  const two = twoProjects();
  let app: INestApplication;
  let db: Database;
  let a: TestAccount;
  let b: TestAccount;

  const get = (path: string, apiKey?: string) => {
    const call = request(serverOf(app)).get(path);

    return apiKey === undefined
      ? call
      : call.set('Authorization', `Bearer ${apiKey}`);
  };

  const paymentBodyWith = (overrides: Record<string, unknown> = {}) => ({
    provider: 'fake',
    amountMinor: uniqueAmountMinor(),
    currency: 'USD',
    description: 'project check',
    returnUrl: RETURN_URL,
    ...overrides,
  });

  const postPayment = (apiKey: string, body: object, key = newKey()) =>
    request(serverOf(app))
      .post(PAYMENTS_PATH)
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', key)
      .send(body);

  const keyRowsNamed = (key: string) =>
    db
      .select({
        projectId: idempotencyKeys.projectId,
        scope: idempotencyKeys.scope,
      })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key));

  const paymentsWithAmount = (projectId: string, amountMinor: number) =>
    db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.projectId, projectId),
          eq(payments.amountMinor, amountMinor),
        ),
      );

  const createProject = async (label: string): Promise<string> => {
    const [{ id }] = await db
      .insert(projects)
      .values({
        slug: `project-${label}-${randomBytes(SLUG_SUFFIX_BYTES).toString('hex')}`,
        name: `Project ${label}`,
      })
      .returning({ id: projects.id });

    return id;
  };

  const setReturnOrigins = (projectId: string, origins: string[]) =>
    db
      .update(projects)
      .set({ allowedReturnOrigins: origins })
      .where(eq(projects.id, projectId));

  const slugOf = async (projectId: string): Promise<string> => {
    const [{ slug }] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId));

    return slug;
  };

  const rowsHolding = async (table: string, value: string): Promise<number> => {
    const [{ matching_rows: matchingRows }] = await db.execute<{
      matching_rows: number;
    }>(sql`
      select count(*)::int as matching_rows
      from ${sql.identifier(table)} as candidate
      where candidate::text like ${`%${value}%`}
    `);

    return matchingRows;
  };

  const insertPaymentOf = async (
    account: TestAccount,
    status: Payment['status'],
  ): Promise<Payment> => {
    const id = randomUUID();
    const amountMinor = uniqueAmountMinor();
    const [payment] = await db
      .insert(payments)
      .values({
        id,
        projectId: account.projectId,
        providerAccountId: account.accountId,
        provider: 'fake',
        providerPaymentId: encodeFakeId({
          reference: id,
          amountMinor,
          currency: 'USD',
        }),
        purpose: 'one_off',
        origin: 'api',
        status,
        amountMinor,
        currency: 'USD',
        createdAt: sql`clock_timestamp() - interval '1 hour'`,
        reconcileAfter: sql`clock_timestamp() + interval '1 hour'`,
      })
      .returning();

    return payment;
  };

  beforeAll(async () => {
    app = await createE2eApp({
      classOverrides: [two.override],
      extraControllers: [ProjectEchoController, ProjectUndeclaredController],
    });
    db = app.get<Database>(DRIZZLE);
    ({ a, b } = await two.create(app));
    await setReturnOrigins(a.projectId, [SHOP_ORIGIN]);
    await setReturnOrigins(b.projectId, [SHOP_ORIGIN]);
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

  describe('create-api-key', () => {
    it('stores only the sha256 of the whole key and its 12-character prefix', async () => {
      const created = await createApiKey(db, {
        projectSlug: await slugOf(a.projectId),
        name: 'script',
        expiresInDays: null,
      });

      const [row] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, created.apiKeyId));
      expect(created.apiKey).toMatch(/^pv_test_[A-Za-z0-9_-]{43}$/);
      expect(row).toMatchObject({
        projectId: a.projectId,
        name: 'script',
        keyHash: sha256Hex(created.apiKey),
        keyPrefix: created.apiKey.slice(0, 12),
        expiresAt: null,
        revokedAt: null,
      });
      expect(await rowsHolding('api_keys', created.apiKey)).toBe(0);
    });

    it('gives two runs two different keys that both open the project', async () => {
      const apiKeyRequest = {
        projectSlug: await slugOf(a.projectId),
        name: 'script twice',
        expiresInDays: null,
      };

      const first = await createApiKey(db, apiKeyRequest);
      const second = await createApiKey(db, apiKeyRequest);

      expect(second.apiKey).not.toBe(first.apiKey);
      for (const { apiKey } of [first, second]) {
        const response = await get(ECHO_PATH, apiKey).expect(200);
        expect(response.body).toEqual({ projectId: a.projectId });
      }
    });

    it('sets the expiry the given number of days ahead', async () => {
      const created = await createApiKey(db, {
        projectSlug: await slugOf(a.projectId),
        name: 'script expiring',
        expiresInDays: 30,
      });

      const [{ is_in_window: isInWindow }] = await db.execute<{
        is_in_window: boolean;
      }>(sql`
        select expires_at > clock_timestamp() + interval '29 days'
          and expires_at <= clock_timestamp() + interval '30 days' as is_in_window
        from api_keys where id = ${created.apiKeyId}
      `);
      expect(isInWindow).toBe(true);
    });

    it('refuses an unknown slug and writes nothing', async () => {
      const name = `script-${randomUUID()}`;

      await expect(
        createApiKey(db, {
          projectSlug: 'no-such-project',
          name,
          expiresInDays: null,
        }),
      ).rejects.toThrow('No project with slug no-such-project');
      expect(
        await db.select().from(apiKeys).where(eq(apiKeys.name, name)),
      ).toEqual([]);
    });
  });

  describe('the project key guard', () => {
    it('hands each key its own project', async () => {
      const responseA = await get(ECHO_PATH, a.apiKey).expect(200);
      const responseB = await get(ECHO_PATH, b.apiKey).expect(200);

      expect(responseA.body).toEqual({ projectId: a.projectId });
      expect(responseB.body).toEqual({ projectId: b.projectId });
    });

    it.each([
      ['a missing header', () => Promise.resolve(undefined)],
      ['a malformed key', () => Promise.resolve('not-a-project-key')],
      [
        'an unknown well-formed key',
        () => Promise.resolve(`pv_test_${'u'.repeat(43)}`),
      ],
      [
        'a revoked key',
        async () => {
          const { apiKeyId, apiKey } = await insertApiKey(db, a.projectId);
          await db
            .update(apiKeys)
            .set({ revokedAt: sql`clock_timestamp()` })
            .where(eq(apiKeys.id, apiKeyId));

          return apiKey;
        },
      ],
      [
        'a key that expired a second ago',
        async () => {
          const { apiKeyId, apiKey } = await insertApiKey(db, a.projectId);
          await db
            .update(apiKeys)
            .set({
              expiresAt: sql`clock_timestamp() - interval '1 second'`,
            })
            .where(eq(apiKeys.id, apiKeyId));

          return apiKey;
        },
      ],
      [
        'a key of an archived project',
        async () => {
          const projectId = await createProject('archived');
          const { apiKey } = await insertApiKey(db, projectId);
          await db
            .update(projects)
            .set({ status: 'archived' })
            .where(eq(projects.id, projectId));

          return apiKey;
        },
      ],
    ])('answers the same 401 for %s', async (_case, apiKeyFor) => {
      const response = await get(ECHO_PATH, await apiKeyFor()).expect(401);

      expect(response.body).toEqual(UNAUTHORIZED_BODY);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    it('accepts a key that expires in an hour', async () => {
      const { apiKeyId, apiKey } = await insertApiKey(db, a.projectId);
      await db
        .update(apiKeys)
        .set({ expiresAt: sql`clock_timestamp() + interval '1 hour'` })
        .where(eq(apiKeys.id, apiKeyId));

      const response = await get(ECHO_PATH, apiKey).expect(200);

      expect(response.body).toEqual({ projectId: a.projectId });
    });

    it('refuses a key on the next request after its revocation', async () => {
      const { apiKeyId, apiKey } = await insertApiKey(db, a.projectId);
      await get(ECHO_PATH, apiKey).expect(200);

      await db
        .update(apiKeys)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(eq(apiKeys.id, apiKeyId));

      await get(ECHO_PATH, apiKey).expect(401);
    });
  });

  describe('the retired API_KEY_SHA256', () => {
    const createAppWithApiKeyHash = async (
      apiKeyHash: string | undefined,
    ): Promise<INestApplication> => {
      const previousHash = process.env.API_KEY_SHA256;
      const setHash = (value: string | undefined): void => {
        if (value === undefined) delete process.env.API_KEY_SHA256;
        else process.env.API_KEY_SHA256 = value;
      };
      setHash(apiKeyHash);

      try {
        return await createE2eApp({
          extraControllers: [ProjectEchoController],
        });
      } finally {
        setHash(previousHash);
      }
    };

    it('boots with the variable unset and never configures it', async () => {
      const appWithoutHash = await createAppWithApiKeyHash(undefined);

      try {
        expect(
          appWithoutHash.get(ConfigService).get<string>('API_KEY_SHA256'),
        ).toBeUndefined();
      } finally {
        await appWithoutHash.close();
      }
    });

    it('opens nothing even while the environment still holds its hash', async () => {
      const appWithOldHash = await createAppWithApiKeyHash(
        sha256Hex(OLD_LOCAL_API_KEY),
      );

      try {
        for (const oldKey of [OLD_LOCAL_API_KEY, OLD_E2E_API_KEY]) {
          const response = await request(serverOf(appWithOldHash))
            .get(ECHO_PATH)
            .set('Authorization', `Bearer ${oldKey}`)
            .expect(401);
          expect(response.body).toEqual(UNAUTHORIZED_BODY);
        }
      } finally {
        await appWithOldHash.close();
      }
    });

    it('leaves the seed project reachable through its stored test key', async () => {
      expect(API_KEY_PATTERN.test(TEST_API_KEY)).toBe(true);

      await get(ECHO_PATH, TEST_API_KEY).expect(200);
    });
  });

  describe("another project's payment", () => {
    const reconcileAfterTextOf = async (paymentId: string): Promise<string> => {
      const [{ reconcile_after: reconcileAfter }] = await db.execute<{
        reconcile_after: string;
      }>(
        sql`select reconcile_after::text as reconcile_after from payments where id = ${paymentId}`,
      );

      return reconcileAfter;
    };

    const isReconcileAfterChanged = async (
      paymentId: string,
      before: string,
    ): Promise<boolean> => {
      const [{ is_changed: isChanged }] = await db.execute<{
        is_changed: boolean;
      }>(sql`
        select reconcile_after is distinct from ${before}::timestamptz as is_changed
        from payments where id = ${paymentId}
      `);

      return isChanged;
    };

    it('is 404 on GET and gets no reconciliation nudge, while its own key nudges it', async () => {
      const payment = await insertPaymentOf(b, 'pending');
      const before = await reconcileAfterTextOf(payment.id);

      const response = await get(
        `${PAYMENTS_PATH}/${payment.id}`,
        a.apiKey,
      ).expect(404);

      expect(response.body).toEqual({
        statusCode: 404,
        code: 'payment_not_found',
        message: 'Payment not found',
      });
      expect(await isReconcileAfterChanged(payment.id, before)).toBe(false);

      await get(`${PAYMENTS_PATH}/${payment.id}`, b.apiKey).expect(200);
      expect(await isReconcileAfterChanged(payment.id, before)).toBe(true);
    });

    it('is 404 on refund and leaves no refund and no key', async () => {
      const payment = await insertPaymentOf(b, 'succeeded');
      const key = newKey();

      const response = await request(serverOf(app))
        .post(`${PAYMENTS_PATH}/${payment.id}/refunds`)
        .set('Authorization', `Bearer ${a.apiKey}`)
        .set('Idempotency-Key', key)
        .send({ amountMinor: 100 })
        .expect(404);

      expect(response.body).toMatchObject({ code: 'payment_not_found' });
      expect(
        await db
          .select()
          .from(refunds)
          .where(eq(refunds.paymentId, payment.id)),
      ).toEqual([]);
      expect(await keyRowsNamed(key)).toEqual([]);
    });
  });

  describe('payment creation', () => {
    it("records key A's payment and its key under project A and its account", async () => {
      const key = newKey();

      const response = await postPayment(
        a.apiKey,
        paymentBodyWith(),
        key,
      ).expect(201);

      const [payment] = await db
        .select({
          projectId: payments.projectId,
          providerAccountId: payments.providerAccountId,
        })
        .from(payments)
        .where(
          eq(payments.id, (response.body as { paymentId: string }).paymentId),
        );
      expect(payment).toEqual({
        projectId: a.projectId,
        providerAccountId: a.accountId,
      });
      expect(await keyRowsNamed(key)).toEqual([
        { projectId: a.projectId, scope: 'api:create_payment' },
      ]);
    });

    it('refuses a projectId in the body with 400 validation_failed', async () => {
      const key = newKey();

      const response = await postPayment(
        a.apiKey,
        paymentBodyWith({ projectId: b.projectId }),
        key,
      ).expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'validation_failed',
        issues: [{ field: 'projectId' }],
      });
      expect(await keyRowsNamed(key)).toEqual([]);
    });

    it('answers 422 for a provider the project has no account for, writing nothing', async () => {
      const key = newKey();
      const body = paymentBodyWith({ provider: 'paddle' });

      const response = await postPayment(b.apiKey, body, key).expect(422);

      expect(response.body).toMatchObject({ code: 'provider_not_available' });
      expect(await keyRowsNamed(key)).toEqual([]);
      expect(await paymentsWithAmount(b.projectId, body.amountMinor)).toEqual(
        [],
      );
    });
  });

  describe('returnUrl origins', () => {
    it.each([
      'https://shop.example/return',
      'https://shop.example/other/path?order=42',
    ])('accepts %s for https://shop.example', async (returnUrl) => {
      await postPayment(a.apiKey, paymentBodyWith({ returnUrl })).expect(201);
    });

    it.each([
      'https://shop.example.evil.test/return',
      'http://shop.example/return',
      'https://shop.example:8443/return',
      'https://shop.example@evil.test/return',
    ])(
      'answers 400 return_url_not_allowed for %s, writing nothing',
      async (returnUrl) => {
        const createPayment = jest.spyOn(
          FakeProvider.prototype,
          'createPayment',
        );
        const key = newKey();
        const body = paymentBodyWith({ returnUrl });

        const response = await postPayment(a.apiKey, body, key).expect(400);

        expect(response.body).toEqual(RETURN_URL_NOT_ALLOWED_BODY);
        expect(createPayment).not.toHaveBeenCalled();
        expect(await keyRowsNamed(key)).toEqual([]);
        expect(await paymentsWithAmount(a.projectId, body.amountMinor)).toEqual(
          [],
        );
      },
    );

    it('refuses every returnUrl of a project with no origins', async () => {
      const projectId = await createProject('no-origins');
      const { apiKey } = await insertApiKey(db, projectId);
      const key = newKey();

      const response = await postPayment(apiKey, paymentBodyWith(), key).expect(
        400,
      );

      expect(response.body).toEqual(RETURN_URL_NOT_ALLOWED_BODY);
      expect(await keyRowsNamed(key)).toEqual([]);
    });
  });

  describe('idempotency keys', () => {
    const requestIn = (projectId: string, key: string): IdempotentRequest => ({
      projectId,
      scope: 'api:create_payment',
      key,
      requestHash: 'a'.repeat(64),
    });

    it('replays and refuses a reused key within one project as before', async () => {
      const key = newKey();
      const body = paymentBodyWith();
      const first = await postPayment(a.apiKey, body, key).expect(201);

      const replay = await postPayment(a.apiKey, body, key).expect(201);
      const reused = await postPayment(a.apiKey, paymentBodyWith(), key).expect(
        422,
      );

      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(reused.body).toMatchObject({ code: 'idempotency_key_reused' });
    });

    it("never reads another project's key of the same name", async () => {
      const key = newKey();
      await db.insert(idempotencyKeys).values({
        ...requestIn(a.projectId, key),
        status: 'completed',
        responseStatus: 201,
        responseBody: {},
        completedAt: sql`clock_timestamp()`,
      });
      const repository = app.get(IdempotencyRepository);

      expect(
        await repository.findState(requestIn(b.projectId, key)),
      ).toBeNull();
      expect(
        await repository.findLiveCompleted(requestIn(b.projectId, key)),
      ).toBeNull();
      expect(
        await repository.findState(requestIn(a.projectId, key)),
      ).toMatchObject({ status: 'completed' });
    });

    it('claims on (project_id, scope, key) and purges by that tuple behind the outer cutoff', async () => {
      const queries: string[] = [];
      const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      const loggedDb = drizzle(client, {
        logger: { logQuery: (query) => queries.push(query) },
      });
      const repository = new IdempotencyRepository(loggedDb);
      const key = newKey();

      try {
        await loggedDb.transaction((tx) =>
          repository.claim(tx, requestIn(a.projectId, key)),
        );
        await repository.purgeExpired(0);
      } finally {
        await client.end();
      }

      const [claimQuery] = queries.filter((query) => /^insert/i.test(query));
      const [purgeQuery] = queries.filter((query) => /^delete/i.test(query));
      expect(claimQuery).toMatch(
        /on conflict \("project_id","scope","key"\) do update/i,
      );
      expect(purgeQuery).toMatch(
        /\("idempotency_keys"\."project_id", "idempotency_keys"\."scope", "idempotency_keys"\."key"\) IN \(\s*SELECT project_id, scope, key FROM idempotency_keys\s+WHERE created_at <= clock_timestamp\(\)/i,
      );
      expect(purgeQuery).toMatch(
        /\)\s*and "idempotency_keys"\."created_at" <= clock_timestamp\(\)/i,
      );
      expect(
        await db
          .select({ projectId: idempotencyKeys.projectId })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.key, key),
              eq(idempotencyKeys.projectId, a.projectId),
            ),
          ),
      ).toHaveLength(1);
    });
  });

  describe('the bearer token', () => {
    it('is in no log line on any 401 path', async () => {
      const { apiKeyId, apiKey: revokedKey } = await insertApiKey(
        db,
        a.projectId,
      );
      await db
        .update(apiKeys)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(eq(apiKeys.id, apiKeyId));
      const unknownKey = `pv_test_${'z'.repeat(43)}`;
      const malformedKey = 'pv_test_tooshort';
      const logs = captureLogs();

      for (const token of [revokedKey, unknownKey, malformedKey]) {
        await get(ECHO_PATH, token).expect(401);
      }
      await get(UNDECLARED_PATH, a.apiKey).expect(401);

      expect(logs()).toContain('ProjectUndeclaredController.handle');
      for (const token of [revokedKey, unknownKey, malformedKey, a.apiKey]) {
        expect(logs()).not.toContain(token);
      }
    });
  });
});
