import { assertSeedTarget } from './seed-fake-account';

const DATABASE_URL = 'postgres://postgres@db.example.test:5432/payvolok';

describe('assertSeedTarget', () => {
  it('refuses without --target-host and names the DATABASE_URL host', () => {
    expect(() =>
      assertSeedTarget({
        databaseUrl: DATABASE_URL,
        nodeEnv: 'development',
        targetHost: null,
      }),
    ).toThrow(
      'DATABASE_URL points at db.example.test; pass --target-host db.example.test to seed it',
    );
  });

  it('refuses a --target-host other than the DATABASE_URL host', () => {
    expect(() =>
      assertSeedTarget({
        databaseUrl: DATABASE_URL,
        nodeEnv: 'development',
        targetHost: '127.0.0.1',
      }),
    ).toThrow(
      '--target-host 127.0.0.1 does not match the DATABASE_URL host db.example.test',
    );
  });

  it('accepts a --target-host equal to the DATABASE_URL host, in any case', () => {
    expect(() =>
      assertSeedTarget({
        databaseUrl: DATABASE_URL,
        nodeEnv: 'development',
        targetHost: 'DB.example.test',
      }),
    ).not.toThrow();
  });

  it('refuses NODE_ENV=production even with a matching host', () => {
    expect(() =>
      assertSeedTarget({
        databaseUrl: DATABASE_URL,
        nodeEnv: 'production',
        targetHost: 'db.example.test',
      }),
    ).toThrow('The fake provider account is never seeded in production');
  });
});
