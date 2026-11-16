import { createHash } from 'node:crypto';

import {
  API_KEY_PATTERN,
  apiKeyHashOf,
  apiKeyPrefixOf,
  generateApiKey,
} from './api-key';

const KEY_COUNT = 50;

describe('generateApiKey', () => {
  it('makes pv_test_ keys of 43 base64url characters', () => {
    for (let index = 0; index < KEY_COUNT; index += 1) {
      expect(generateApiKey()).toMatch(/^pv_test_[A-Za-z0-9_-]{43}$/);
    }
  });

  it('never repeats a key', () => {
    const keys = new Set(
      Array.from({ length: KEY_COUNT }, () => generateApiKey()),
    );

    expect(keys.size).toBe(KEY_COUNT);
  });
});

describe('API_KEY_PATTERN', () => {
  it('accepts a generated key', () => {
    expect(API_KEY_PATTERN.test(generateApiKey())).toBe(true);
  });

  it.each([
    ['42 characters after the prefix', `pv_test_${'a'.repeat(42)}`],
    ['44 characters after the prefix', `pv_test_${'a'.repeat(44)}`],
    ['another prefix', `pv_live_${'a'.repeat(43)}`],
    ['a character outside base64url', `pv_test_${'a'.repeat(42)}+`],
    ['the old local key', 'local-dev-api-key'],
  ])('refuses %s', (_case, apiKey) => {
    expect(API_KEY_PATTERN.test(apiKey)).toBe(false);
  });
});

describe('apiKeyHashOf', () => {
  it('is the sha256 hex of the whole key', () => {
    const apiKey = generateApiKey();

    expect(apiKeyHashOf(apiKey)).toBe(
      createHash('sha256').update(apiKey).digest('hex'),
    );
  });

  it('differs for two keys that share their prefix', () => {
    const apiKey = generateApiKey();
    const otherKey = `${apiKeyPrefixOf(apiKey)}${'a'.repeat(apiKey.length - 12)}`;

    expect(apiKeyHashOf(otherKey)).not.toBe(apiKeyHashOf(apiKey));
  });
});

describe('apiKeyPrefixOf', () => {
  it('keeps the first 12 characters', () => {
    const apiKey = generateApiKey();

    expect(apiKeyPrefixOf(apiKey)).toBe(apiKey.slice(0, 12));
    expect(apiKeyPrefixOf(apiKey)).toHaveLength(12);
  });
});
