import { createHmac } from 'node:crypto';

import {
  isSignatureValid,
  parseSignatureHeader,
  signatureHeaderOf,
} from './paddle-signature';

const SECRET = 'pdl_ntfset_01jcsyntheticsecret00000001_AbCdEf';
const OTHER_SECRET = 'pdl_ntfset_01jcsyntheticsecret00000002_XyZ';
const NOW_EPOCH_MS = 1_762_855_200_000;
const NOW_SECONDS = NOW_EPOCH_MS / 1000;
const RAW_BODY = Buffer.from(
  '{"event_id":"evt_01jcsyntheticevent00000001","event_type":"transaction.completed"}',
);

const hmacOf = (timestamp: number, rawBody: Buffer, secret = SECRET): string =>
  createHmac('sha256', secret)
    .update(`${timestamp}:${rawBody.toString('utf8')}`)
    .digest('hex');

const isValid = (
  header: string | readonly string[] | undefined,
  rawBody = RAW_BODY,
): boolean => isSignatureValid(header, rawBody, SECRET, NOW_EPOCH_MS);

describe('isSignatureValid', () => {
  it('accepts a correctly signed body', () => {
    expect(
      isValid(`ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY)}`),
    ).toBe(true);
  });

  it('accepts a header built by signatureHeaderOf', () => {
    expect(isValid(signatureHeaderOf(RAW_BODY, SECRET, NOW_EPOCH_MS))).toBe(
      true,
    );
  });

  it('accepts timestamps 300 s in the past and in the future', () => {
    for (const timestamp of [NOW_SECONDS - 300, NOW_SECONDS + 300]) {
      expect(isValid(`ts=${timestamp};h1=${hmacOf(timestamp, RAW_BODY)}`)).toBe(
        true,
      );
    }
  });

  it('accepts two h1 values when only the second matches', () => {
    const header = `ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY, OTHER_SECRET)};h1=${hmacOf(NOW_SECONDS, RAW_BODY)}`;

    expect(isValid(header)).toBe(true);
  });

  it('rejects a body with one flipped byte', () => {
    const flippedBody = Buffer.from(RAW_BODY);
    flippedBody[5] ^= 1;

    expect(
      isValid(
        `ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY)}`,
        flippedBody,
      ),
    ).toBe(false);
  });

  it.each([
    ['a missing header', undefined],
    [
      'an array header',
      [`ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY)}`],
    ],
    ['no ts', `h1=${hmacOf(NOW_SECONDS, RAW_BODY)}`],
    ['a non-numeric ts', `ts=12a;h1=${hmacOf(NOW_SECONDS, RAW_BODY)}`],
    [
      'two ts',
      `ts=${NOW_SECONDS};ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY)}`,
    ],
    ['no h1', `ts=${NOW_SECONDS}`],
    [
      'an element without =',
      `ts=${NOW_SECONDS};${hmacOf(NOW_SECONDS, RAW_BODY)}`,
    ],
    [
      'a truncated h1',
      `ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY).slice(0, -1)}`,
    ],
    [
      'an uppercase h1',
      `ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY).toUpperCase()}`,
    ],
    [
      'another secret',
      `ts=${NOW_SECONDS};h1=${hmacOf(NOW_SECONDS, RAW_BODY, OTHER_SECRET)}`,
    ],
    [
      'a ts 301 s old',
      `ts=${NOW_SECONDS - 301};h1=${hmacOf(NOW_SECONDS - 301, RAW_BODY)}`,
    ],
    [
      'a ts 301 s in the future',
      `ts=${NOW_SECONDS + 301};h1=${hmacOf(NOW_SECONDS + 301, RAW_BODY)}`,
    ],
    ['an empty header', ''],
  ])('rejects %s', (_case, header) => {
    expect(isValid(header)).toBe(false);
  });
});

describe('parseSignatureHeader', () => {
  it('splits each element on its first =', () => {
    expect(parseSignatureHeader('ts=1;h1=a=b;h1=c')).toEqual({
      timestamp: '1',
      signatures: ['a=b', 'c'],
    });
  });

  it('ignores keys it does not know', () => {
    expect(parseSignatureHeader('ts=1;h2=x;h1=c')).toEqual({
      timestamp: '1',
      signatures: ['c'],
    });
  });
});
