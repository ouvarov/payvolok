import type { WebhookRequest } from '@/providers/payment-provider.port';
import { dedupKeyFromBody } from '@/providers/provider-events';

const ALWAYS_STORED_HEADERS = ['content-type', 'content-length', 'user-agent'];
const STORABLE_DEDUP_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const CONTROL_CHARACTERS_PATTERN = /\p{Cc}/gu;

// An allowlist: no list of names can cover every header that carries a credential.
const storableHeaders = (
  headers: WebhookRequest['headers'],
  providerHeaders: readonly string[],
): Record<string, string | string[]> => {
  const storedNames = new Set([...ALWAYS_STORED_HEADERS, ...providerHeaders]);

  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value !== undefined && storedNames.has(name)
        ? [[name, typeof value === 'string' ? value : [...value]]]
        : [],
    ),
  );
};

// A key Postgres refuses or an index cannot hold would fail every delivery and
// the provider would retry forever.
const storableDedupKey = (dedupKey: string): string =>
  STORABLE_DEDUP_KEY_PATTERN.test(dedupKey)
    ? dedupKey
    : dedupKeyFromBody(Buffer.from(dedupKey));

const withoutControlCharacters = (text: string): string =>
  text.replace(CONTROL_CHARACTERS_PATTERN, '');

export { storableDedupKey, storableHeaders, withoutControlCharacters };
