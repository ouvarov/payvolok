import type { WebhookRequest } from '@/providers/payment-provider.port';
import { dedupKeyFromBody } from '@/providers/provider-events';

const DROPPED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-real-ip',
  'cf-connecting-ip',
]);
const DROPPED_HEADER_PATTERN = /^x-forwarded-|token|secret|password|api-?key/i;
const STORABLE_DEDUP_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const CONTROL_CHARACTERS_PATTERN = /\p{Cc}/gu;

const isStoredHeader = (name: string): boolean =>
  !DROPPED_HEADER_NAMES.has(name.toLowerCase()) &&
  !DROPPED_HEADER_PATTERN.test(name);

const storableHeaders = (
  headers: WebhookRequest['headers'],
): Record<string, string | string[]> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value !== undefined && isStoredHeader(name)
        ? [[name, typeof value === 'string' ? value : [...value]]]
        : [],
    ),
  );

// A key Postgres refuses or an index cannot hold would fail every delivery and
// the provider would retry forever.
const storableDedupKey = (dedupKey: string): string =>
  STORABLE_DEDUP_KEY_PATTERN.test(dedupKey)
    ? dedupKey
    : dedupKeyFromBody(Buffer.from(dedupKey));

const withoutControlCharacters = (text: string): string =>
  text.replace(CONTROL_CHARACTERS_PATTERN, '');

export { storableDedupKey, storableHeaders, withoutControlCharacters };
