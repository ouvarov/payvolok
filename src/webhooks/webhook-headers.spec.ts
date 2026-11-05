import {
  storableDedupKey,
  storableHeaders,
  withoutControlCharacters,
} from './webhook-headers';

const PROVIDER_HEADERS = ['x-provider-signature'];

describe('storableHeaders', () => {
  it.each([
    'authorization',
    'x-authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'forwarded',
    'x-forwarded-for',
    'x-real-ip',
    'true-client-ip',
    'cf-connecting-ip',
    'x-session-id',
    'x-auth-token',
    'x-client-secret',
    'api_key',
    'x-api-key',
    'x-request-id',
    'x-anything-unknown',
  ])('drops %s', (name) => {
    expect(storableHeaders({ [name]: 'value' }, PROVIDER_HEADERS)).toEqual({});
  });

  it.each([
    'content-type',
    'content-length',
    'user-agent',
    'x-provider-signature',
  ])('keeps %s', (name) => {
    expect(storableHeaders({ [name]: 'value' }, PROVIDER_HEADERS)).toEqual({
      [name]: 'value',
    });
  });

  it('drops a header another provider declares', () => {
    expect(storableHeaders({ 'x-provider-signature': 'value' }, [])).toEqual(
      {},
    );
  });

  it('keeps a repeated header as an array and skips an undefined value', () => {
    expect(
      storableHeaders(
        { 'x-provider-signature': ['one', 'two'], 'user-agent': undefined },
        PROVIDER_HEADERS,
      ),
    ).toEqual({ 'x-provider-signature': ['one', 'two'] });
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
