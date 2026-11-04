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

  it('rejects an unknown NODE_ENV', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: VALID_DATABASE_URL, NODE_ENV: 'staging' }),
    ).toThrow(/NODE_ENV/);
  });
});
