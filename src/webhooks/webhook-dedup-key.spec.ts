import { storableDedupKey } from './webhook-dedup-key';

describe('storableDedupKey', () => {
  it.each(['evt_1', 'a'.repeat(255), '!~', 'evt:invalid:1'])(
    'keeps %s',
    (dedupKey) => {
      expect(storableDedupKey(dedupKey)).toBe(dedupKey);
    },
  );

  it.each([
    ['a NUL byte', 'evt\u00001'],
    ['a space', 'evt 1'],
    ['a non-ascii character', 'evté1'],
    ['256 characters', 'a'.repeat(256)],
    ['nothing', ''],
    ['the invalid-signature prefix', `invalid:${'a'.repeat(64)}`],
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
