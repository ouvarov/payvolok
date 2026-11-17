import { createHash, randomBytes } from 'node:crypto';

const API_KEY_PREFIX = 'pv_test_';
const API_KEY_RANDOM_BYTES = 32;
const API_KEY_DISPLAY_PREFIX_LENGTH = 12;
const API_KEY_PATTERN = /^pv_test_[A-Za-z0-9_-]{43}$/;

const generateApiKey = (): string =>
  API_KEY_PREFIX + randomBytes(API_KEY_RANDOM_BYTES).toString('base64url');

const apiKeyHashOf = (apiKey: string): string =>
  createHash('sha256').update(apiKey).digest('hex');

const apiKeyPrefixOf = (apiKey: string): string =>
  apiKey.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);

export { API_KEY_PATTERN, apiKeyHashOf, apiKeyPrefixOf, generateApiKey };
