import { demoTokenOf, isDemoTokenOf } from './demo-token';

const SECRET = 's'.repeat(32);
const PAYMENT_ID = '0b9d6f0e-5a4b-4c1e-9f3a-111111111111';
const OTHER_PAYMENT_ID = '0b9d6f0e-5a4b-4c1e-9f3a-222222222222';

describe('demoTokenOf', () => {
  it('is pvd_ plus 43 base64url characters', () => {
    expect(demoTokenOf(SECRET, PAYMENT_ID)).toMatch(/^pvd_[A-Za-z0-9_-]{43}$/);
  });

  it('is the same for the same payment and secret', () => {
    expect(demoTokenOf(SECRET, PAYMENT_ID)).toBe(
      demoTokenOf(SECRET, PAYMENT_ID),
    );
  });

  it('differs for another payment or another secret', () => {
    const token = demoTokenOf(SECRET, PAYMENT_ID);

    expect(demoTokenOf(SECRET, OTHER_PAYMENT_ID)).not.toBe(token);
    expect(demoTokenOf('t'.repeat(32), PAYMENT_ID)).not.toBe(token);
  });
});

describe('isDemoTokenOf', () => {
  const token = demoTokenOf(SECRET, PAYMENT_ID);

  it('accepts the token of the payment', () => {
    expect(isDemoTokenOf(SECRET, PAYMENT_ID, token)).toBe(true);
  });

  it.each([
    ['no token', undefined],
    ['an empty token', ''],
    ['a truncated token', token.slice(0, -1)],
    ['a longer token', `${token}A`],
    [
      'a token with one character changed',
      `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
    ],
    ['another payment token', demoTokenOf(SECRET, OTHER_PAYMENT_ID)],
    ['a multibyte token of the same length', `pvd_${'é'.repeat(43)}`],
  ])('refuses %s', (_case, candidate) => {
    expect(isDemoTokenOf(SECRET, PAYMENT_ID, candidate)).toBe(false);
  });
});
