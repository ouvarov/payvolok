import { dedupKeyFromBody } from '@/providers/provider-events';

const INVALID_DEDUP_KEY_PREFIX = 'invalid:';
const STORABLE_DEDUP_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

// A key Postgres refuses or an index cannot hold would fail every delivery and
// the provider would retry forever. One shaped like an invalid-signature key
// could hit that row's conflict and be dropped with a 200.
const storableDedupKey = (dedupKey: string): string =>
  STORABLE_DEDUP_KEY_PATTERN.test(dedupKey) &&
  !dedupKey.startsWith(INVALID_DEDUP_KEY_PREFIX)
    ? dedupKey
    : dedupKeyFromBody(Buffer.from(dedupKey));

export { INVALID_DEDUP_KEY_PREFIX, storableDedupKey };
