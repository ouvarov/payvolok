import {
  storableDedupKey,
  storableHeaders,
  withoutControlCharacters,
} from './webhook-headers';

describe('storableHeaders', () => {
  it.each([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-real-ip',
    'cf-connecting-ip',
    'x-auth-token',
    'x-client-secret',
    'x-password',
    'x-api-key',
    'apikey',
    'X-API-KEY',
  ])('drops %s', (name) => {
    expect(storableHeaders({ [name]: 'value' })).toEqual({});
  });

  it.each(['x-fake-signature', 'content-type', 'user-agent', 'x-request-id'])(
    'keeps %s',
    (name) => {
      expect(storableHeaders({ [name]: 'value' })).toEqual({ [name]: 'value' });
    },
  );

  it('keeps a repeated header as an array and skips an undefined value', () => {
    expect(
      storableHeaders({ 'x-repeated': ['one', 'two'], 'x-absent': undefined }),
    ).toEqual({ 'x-repeated': ['one', 'two'] });
  });
});

describe('storableDedupKey', () => {
  it.each(['evt_1', 'a'.repeat(255), '!~'])('keeps %s', (dedupKey) => {
    expect(storableDedupKey(dedupKey)).toBe(dedupKey);
  });

  it.each([
    ['a NUL byte', 'evt\u00001'],
    ['a space', 'evt 1'],
    ['a non-ascii character', 'evté1'],
    ['256 characters', 'a'.repeat(256)],
    ['nothing', ''],
  ])('hashes a key with %s', (_case, dedupKey) => {
    expect(storableDedupKey(dedupKey)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hashes one key to one value and two keys to two values', () => {
    const longKey = 'a'.repeat(256);

    expect(storableDedupKey(longKey)).toBe(storableDedupKey(longKey));
    expect(storableDedupKey(longKey)).not.toBe(
      storableDedupKey('b'.repeat(256)),
    );
  });
});

describe('withoutControlCharacters', () => {
  it('removes control characters and keeps other text', () => {
    expect(withoutControlCharacters('card\u0000 de\u0007clined\n é')).toBe(
      'card declined é',
    );
  });
});
