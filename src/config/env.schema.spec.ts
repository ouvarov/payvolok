import { validateEnv } from './env.schema';

const VALID_DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
const VALID_API_KEY_SHA256 = 'a1'.repeat(32);
const VALID_PUBLIC_BASE_URL = 'https://payvolok.example.test';
const VALID_ENV = {
  DATABASE_URL: VALID_DATABASE_URL,
  API_KEY_SHA256: VALID_API_KEY_SHA256,
  PUBLIC_BASE_URL: VALID_PUBLIC_BASE_URL,
};

describe('validateEnv', () => {
  it('applies defaults when only the required keys are set', () => {
    expect(validateEnv(VALID_ENV)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: VALID_DATABASE_URL,
      API_KEY_SHA256: VALID_API_KEY_SHA256,
      PUBLIC_BASE_URL: VALID_PUBLIC_BASE_URL,
      DATABASE_POOL_MAX: 10,
      WEBHOOK_WORKER_ENABLED: true,
      WEBHOOK_POLL_INTERVAL_MS: 5000,
    });
  });

  it('coerces PORT and DATABASE_POOL_MAX from strings', () => {
    const env = validateEnv({
      ...VALID_ENV,
      PORT: '8080',
      DATABASE_POOL_MAX: '3',
    });

    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_POOL_MAX).toBe(3);
  });

  it('rejects a missing DATABASE_URL with a message naming it', () => {
    expect(() => validateEnv({})).toThrow(
      /Invalid environment[\s\S]*DATABASE_URL/,
    );
  });

  it('rejects a DATABASE_URL that is not a postgres url', () => {
    expect(() => validateEnv({ DATABASE_URL: 'not a url' })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => validateEnv({ DATABASE_URL: 'http://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it.each(['postgres:foo', 'postgres://', 'postgres:/host/db'])(
    'rejects the malformed DATABASE_URL %s',
    (databaseUrl) => {
      expect(() => validateEnv({ DATABASE_URL: databaseUrl })).toThrow(
        /DATABASE_URL/,
      );
    },
  );

  it('accepts the postgresql scheme', () => {
    const databaseUrl = 'postgresql://user:pass@localhost:5432/db';

    expect(
      validateEnv({ ...VALID_ENV, DATABASE_URL: databaseUrl }).DATABASE_URL,
    ).toBe(databaseUrl);
  });

  describe('API_KEY_SHA256', () => {
    const errorMessageFor = (config: Record<string, unknown>): string => {
      try {
        validateEnv(config);
      } catch (caught) {
        return (caught as Error).message;
      }

      return '';
    };

    it('is required, naming the key', () => {
      expect(errorMessageFor({ DATABASE_URL: VALID_DATABASE_URL })).toContain(
        'API_KEY_SHA256',
      );
    });

    it.each([
      ['uppercase', 'A1'.repeat(32)],
      ['63 characters', 'a'.repeat(63)],
      ['65 characters', 'a'.repeat(65)],
      ['not hex', 'g'.repeat(64)],
      ['empty', ''],
    ])('rejects %s, naming the key without echoing it', (_case, value) => {
      const message = errorMessageFor({ ...VALID_ENV, API_KEY_SHA256: value });

      expect(message).toContain('API_KEY_SHA256');
      if (value !== '') expect(message).not.toContain(value);
    });
  });

  describe('PUBLIC_BASE_URL', () => {
    it('is required, naming the key', () => {
      const { PUBLIC_BASE_URL: _publicBaseUrl, ...envWithoutBaseUrl } =
        VALID_ENV;

      expect(() => validateEnv(envWithoutBaseUrl)).toThrow(/PUBLIC_BASE_URL/);
    });

    it.each([
      ['not a url', 'payvolok.example.test'],
      ['another scheme', 'ftp://payvolok.example.test'],
      ['no host', 'https://'],
      ['empty', ''],
    ])('rejects %s, naming the key', (_case, value) => {
      expect(() =>
        validateEnv({ ...VALID_ENV, PUBLIC_BASE_URL: value }),
      ).toThrow(/PUBLIC_BASE_URL/);
    });

    it.each([
      ['http://localhost:3000', 'http://localhost:3000'],
      ['https://payvolok.example.test/', 'https://payvolok.example.test'],
      ['https://example.test/pay//', 'https://example.test/pay'],
    ])('reads %s as %s', (value, publicBaseUrl) => {
      expect(
        validateEnv({ ...VALID_ENV, PUBLIC_BASE_URL: value }).PUBLIC_BASE_URL,
      ).toBe(publicBaseUrl);
    });
  });

  describe('FAKE_WEBHOOK_SECRET', () => {
    const SECRET_MIN_LENGTH = 32;

    it('is valid when unset and leaves the key absent', () => {
      expect(validateEnv(VALID_ENV)).not.toHaveProperty('FAKE_WEBHOOK_SECRET');
    });

    it('accepts 32 characters', () => {
      const secret = 's'.repeat(SECRET_MIN_LENGTH);

      expect(
        validateEnv({
          ...VALID_ENV,
          FAKE_WEBHOOK_SECRET: secret,
        }).FAKE_WEBHOOK_SECRET,
      ).toBe(secret);
    });

    it('rejects an empty value, naming the key', () => {
      expect(() =>
        validateEnv({
          ...VALID_ENV,
          FAKE_WEBHOOK_SECRET: '',
        }),
      ).toThrow(/FAKE_WEBHOOK_SECRET/);
    });

    it('rejects 31 characters, naming the key without echoing the value', () => {
      const shortSecret = 's'.repeat(SECRET_MIN_LENGTH - 1);

      const error: unknown = (() => {
        try {
          return validateEnv({
            ...VALID_ENV,
            FAKE_WEBHOOK_SECRET: shortSecret,
          });
        } catch (caught) {
          return caught;
        }
      })();

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('FAKE_WEBHOOK_SECRET');
      expect((error as Error).message).not.toContain(shortSecret);
    });
  });

  describe('Paddle variables', () => {
    const VALID_PADDLE_ENV = {
      PADDLE_API_KEY: `pdl_sdbx_apikey_${'a1'.repeat(26)}`,
      PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_01jcsyntheticsecret00000001_AbC',
      PADDLE_CLIENT_TOKEN: `test_${'a1B'.repeat(9)}`,
    };

    const errorMessageFor = (config: Record<string, unknown>): string => {
      try {
        validateEnv(config);
      } catch (caught) {
        return (caught as Error).message;
      }

      return '';
    };

    it('boots with none of them set', () => {
      const env = validateEnv(VALID_ENV);

      expect(env.PADDLE_API_KEY).toBeUndefined();
      expect(env.PADDLE_WEBHOOK_SECRET).toBeUndefined();
      expect(env.PADDLE_CLIENT_TOKEN).toBeUndefined();
    });

    it('reads each of them when valid', () => {
      expect(validateEnv({ ...VALID_ENV, ...VALID_PADDLE_ENV })).toMatchObject(
        VALID_PADDLE_ENV,
      );
    });

    it.each(Object.keys(VALID_PADDLE_ENV))(
      'treats an empty %s as unset',
      (key) => {
        expect(
          validateEnv({ ...VALID_ENV, ...VALID_PADDLE_ENV, [key]: '' })[
            key as keyof typeof VALID_PADDLE_ENV
          ],
        ).toBeUndefined();
      },
    );

    it.each([
      ['PADDLE_API_KEY', `pdl_live_apikey_${'a1'.repeat(26)}`],
      ['PADDLE_API_KEY', 'a1'.repeat(30)],
      ['PADDLE_API_KEY', 'pdl_sdbx_apikey_with space'],
      ['PADDLE_WEBHOOK_SECRET', 'ntfset_01jcsyntheticsecret00000001'],
      ['PADDLE_WEBHOOK_SECRET', 'pdl_ntfset_with space'],
      ['PADDLE_CLIENT_TOKEN', `live_${'a1B'.repeat(9)}`],
      ['PADDLE_CLIENT_TOKEN', 'test_abc</script>'],
      ['PADDLE_CLIENT_TOKEN', "test_abc'+alert(1)+'"],
    ])(
      'rejects %s %j, naming the key without echoing the value',
      (key, value) => {
        const message = errorMessageFor({ ...VALID_ENV, [key]: value });

        expect(message).toContain(key);
        expect(message).not.toContain(value);
      },
    );
  });

  describe('WEBHOOK_POLL_INTERVAL_MS', () => {
    it('accepts 100 and 3600000', () => {
      for (const interval of ['100', '3600000']) {
        expect(
          validateEnv({
            ...VALID_ENV,
            WEBHOOK_POLL_INTERVAL_MS: interval,
          }).WEBHOOK_POLL_INTERVAL_MS,
        ).toBe(Number(interval));
      }
    });

    it.each(['', '99', '100000000', '1.5', 'often'])(
      'rejects %j, naming the key',
      (interval) => {
        expect(() =>
          validateEnv({
            ...VALID_ENV,
            WEBHOOK_POLL_INTERVAL_MS: interval,
          }),
        ).toThrow(/WEBHOOK_POLL_INTERVAL_MS/);
      },
    );
  });

  describe('WEBHOOK_WORKER_ENABLED', () => {
    it.each([
      ['true', true],
      ['false', false],
    ])('reads %s as %s', (value, isEnabled) => {
      expect(
        validateEnv({
          ...VALID_ENV,
          WEBHOOK_WORKER_ENABLED: value,
        }).WEBHOOK_WORKER_ENABLED,
      ).toBe(isEnabled);
    });

    it.each(['', 'maybe', 'ture'])('rejects %j, naming the key', (value) => {
      expect(() =>
        validateEnv({
          ...VALID_ENV,
          WEBHOOK_WORKER_ENABLED: value,
        }),
      ).toThrow(/WEBHOOK_WORKER_ENABLED/);
    });
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...VALID_ENV, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });
});
