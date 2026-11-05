import { validateEnv } from './env.schema';

const VALID_DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

describe('validateEnv', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(validateEnv({ DATABASE_URL: VALID_DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: VALID_DATABASE_URL,
      DATABASE_POOL_MAX: 10,
    });
  });

  it('coerces PORT and DATABASE_POOL_MAX from strings', () => {
    const env = validateEnv({
      DATABASE_URL: VALID_DATABASE_URL,
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

    expect(validateEnv({ DATABASE_URL: databaseUrl }).DATABASE_URL).toBe(
      databaseUrl,
    );
  });

  describe('FAKE_WEBHOOK_SECRET', () => {
    const SECRET_MIN_LENGTH = 32;

    it('is valid when unset and leaves the key absent', () => {
      expect(
        validateEnv({ DATABASE_URL: VALID_DATABASE_URL }),
      ).not.toHaveProperty('FAKE_WEBHOOK_SECRET');
    });

    it('accepts 32 characters', () => {
      const secret = 's'.repeat(SECRET_MIN_LENGTH);

      expect(
        validateEnv({
          DATABASE_URL: VALID_DATABASE_URL,
          FAKE_WEBHOOK_SECRET: secret,
        }).FAKE_WEBHOOK_SECRET,
      ).toBe(secret);
    });

    it('rejects an empty value, naming the key', () => {
      expect(() =>
        validateEnv({
          DATABASE_URL: VALID_DATABASE_URL,
          FAKE_WEBHOOK_SECRET: '',
        }),
      ).toThrow(/FAKE_WEBHOOK_SECRET/);
    });

    it('rejects 31 characters, naming the key without echoing the value', () => {
      const shortSecret = 's'.repeat(SECRET_MIN_LENGTH - 1);

      const error: unknown = (() => {
        try {
          return validateEnv({
            DATABASE_URL: VALID_DATABASE_URL,
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

  it('rejects an unknown NODE_ENV', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: VALID_DATABASE_URL, NODE_ENV: 'staging' }),
    ).toThrow(/NODE_ENV/);
  });
});
