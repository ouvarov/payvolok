import { createHmac, timingSafeEqual } from 'node:crypto';

const DEMO_TOKEN_PREFIX = 'pvd_';

// Stateless: the token is recomputed, never stored, so a replayed answer gets the same one.
const demoTokenOf = (secret: string, paymentId: string): string =>
  DEMO_TOKEN_PREFIX +
  createHmac('sha256', secret).update(`demo:${paymentId}`).digest('base64url');

const isDemoTokenOf = (
  secret: string,
  paymentId: string,
  token: string | undefined,
): boolean => {
  if (token === undefined) return false;

  const expected = Buffer.from(demoTokenOf(secret, paymentId));
  const received = Buffer.from(token);

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
};

export { demoTokenOf, isDemoTokenOf };
