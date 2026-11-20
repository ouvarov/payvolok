import { createHmac } from 'node:crypto';

import {
  isSignatureValid,
  parseSignatureHeader,
  signatureHeaderOf,
} from './stripe-signature';

const SECRET = 'whsec_SyntheticSecret0000000000000001';
const OTHER_SECRET = 'whsec_SyntheticSecret0000000000000002';
const NOW_EPOCH_MS = 1_762_855_200_000;
const NOW_SECONDS = NOW_EPOCH_MS / 1000;
const RAW_BODY = Buffer.from(
  '{"id":"evt_1SyntheticEvent0000000001","type":"checkout.session.completed"}',
);

const hmacOf = (timestamp: number, rawBody: Buffer, secret = SECRET): string =>
  createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

const isValid = (
  header: string | readonly string[] | undefined,
  rawBody = RAW_BODY,
): boolean => isSignatureValid(header, rawBody, SECRET, NOW_EPOCH_MS);

const validV1 = hmacOf(NOW_SECONDS, RAW_BODY);

describe('isSignatureValid', () => {
  it('accepts a correctly signed body', () => {
    expect(isValid(`t=${NOW_SECONDS},v1=${validV1}`)).toBe(true);
  });

  it('accepts a header built by signatureHeaderOf', () => {
    expect(isValid(signatureHeaderOf(RAW_BODY, SECRET, NOW_EPOCH_MS))).toBe(
      true,
    );
  });

  it.each([
    [`v0=abc,t=${NOW_SECONDS},v1=${validV1}`],
    [`t=${NOW_SECONDS},secret=x,v1=${validV1},destination=we_1`],
    [`payload=y,v1=${validV1},v0=${validV1},t=${NOW_SECONDS}`],
    [`destination=we_1,payload=y,secret=x,t=${NOW_SECONDS},v1=${validV1}`],
  ])('ignores the other entries of %s', (header) => {
    expect(isValid(header)).toBe(true);
  });

  it('accepts two v1 values when only the second matches', () => {
    const header = `t=${NOW_SECONDS},v1=${hmacOf(NOW_SECONDS, RAW_BODY, OTHER_SECRET)},v1=${validV1}`;

    expect(isValid(header)).toBe(true);
  });

  it.each([299, 300])(
    'accepts a timestamp %i s in the past and in the future',
    (offsetSeconds) => {
      for (const timestamp of [
        NOW_SECONDS - offsetSeconds,
        NOW_SECONDS + offsetSeconds,
      ]) {
        expect(
          isValid(`t=${timestamp},v1=${hmacOf(timestamp, RAW_BODY)}`),
        ).toBe(true);
      }
    },
  );

  it('rejects a body with one flipped byte', () => {
    const flippedBody = Buffer.from(RAW_BODY);
    flippedBody[5] ^= 1;

    expect(isValid(`t=${NOW_SECONDS},v1=${validV1}`, flippedBody)).toBe(false);
  });

  it.each([
    ['a missing header', undefined],
    ['an array header', [`t=${NOW_SECONDS},v1=${validV1}`]],
    ['only a valid v0', `t=${NOW_SECONDS},v0=${validV1}`],
    ['no t', `v1=${validV1}`],
    ['a non-digit t', `t=12a,v1=${validV1}`],
    ['two t', `t=${NOW_SECONDS},t=${NOW_SECONDS},v1=${validV1}`],
    ['no v1', `t=${NOW_SECONDS}`],
    ['the Paddle separator', `t=${NOW_SECONDS};v1=${validV1}`],
    [
      'a colon in the signed payload',
      `t=${NOW_SECONDS},v1=${createHmac('sha256', SECRET).update(`${NOW_SECONDS}:${RAW_BODY.toString('utf8')}`).digest('hex')}`,
    ],
    ['a truncated v1', `t=${NOW_SECONDS},v1=${validV1.slice(0, -1)}`],
    ['an uppercase v1', `t=${NOW_SECONDS},v1=${validV1.toUpperCase()}`],
    [
      'another secret',
      `t=${NOW_SECONDS},v1=${hmacOf(NOW_SECONDS, RAW_BODY, OTHER_SECRET)}`,
    ],
    [
      'a t 301 s old',
      `t=${NOW_SECONDS - 301},v1=${hmacOf(NOW_SECONDS - 301, RAW_BODY)}`,
    ],
    [
      'a t 301 s in the future',
      `t=${NOW_SECONDS + 301},v1=${hmacOf(NOW_SECONDS + 301, RAW_BODY)}`,
    ],
    ['an empty header', ''],
  ])('rejects %s', (_case, header) => {
    expect(isValid(header)).toBe(false);
  });

  it('accepts a delivery signed with only the second of two secrets', () => {
    const header = signatureHeaderOf(RAW_BODY, SECRET, NOW_EPOCH_MS);

    expect(
      [OTHER_SECRET, SECRET].some((secret) =>
        isSignatureValid(header, RAW_BODY, secret, NOW_EPOCH_MS),
      ),
    ).toBe(true);
    expect(isSignatureValid(header, RAW_BODY, OTHER_SECRET, NOW_EPOCH_MS)).toBe(
      false,
    );
  });
});

describe('parseSignatureHeader', () => {
  it('splits each entry on its first =', () => {
    expect(parseSignatureHeader('t=1,v1=a=b,v1=c')).toEqual({
      timestamp: '1',
      signatures: ['a=b', 'c'],
    });
  });

  it('skips entries without =', () => {
    expect(parseSignatureHeader('t=1,junk,v1=c')).toEqual({
      timestamp: '1',
      signatures: ['c'],
    });
  });
});
