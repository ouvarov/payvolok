import type { WebhookRequest } from '@/providers/payment-provider.port';

const ALWAYS_STORED_HEADERS = ['content-type', 'content-length', 'user-agent'];

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

export { storableHeaders };
