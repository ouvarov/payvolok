import { createHmac, timingSafeEqual } from 'node:crypto';

type PaddleSignatureHeader = { timestamp: string; signatures: string[] };

// Paddle's SDKs allow 5 s; cold starts and clock skew need more, and event_id dedups replays.
const SIGNATURE_TOLERANCE_MS = 300 * 1000;
const TIMESTAMP_PATTERN = /^\d+$/;
const MS_PER_SECOND = 1000;

const parseSignatureHeader = (header: string): PaddleSignatureHeader | null => {
  const timestamps: string[] = [];
  const signatures: string[] = [];

  for (const element of header.split(';')) {
    const separatorIndex = element.indexOf('=');
    if (separatorIndex < 0) return null;

    const key = element.slice(0, separatorIndex);
    const value = element.slice(separatorIndex + 1);
    if (key === 'ts') timestamps.push(value);
    if (key === 'h1') signatures.push(value);
  }

  const [timestamp] = timestamps;
  if (timestamps.length !== 1 || !TIMESTAMP_PATTERN.test(timestamp)) {
    return null;
  }
  if (signatures.length === 0) return null;

  return { timestamp, signatures };
};

const signatureOf = (
  timestamp: string,
  rawBody: Buffer,
  secret: string,
): string =>
  createHmac('sha256', secret)
    .update(`${timestamp}:`)
    .update(rawBody)
    .digest('hex');

// Compared as text: decoding as hex would silently drop invalid characters.
const isSameSignature = (received: string, expected: string): boolean => {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);

  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
};

const isSignatureValid = (
  header: string | readonly string[] | undefined,
  rawBody: Buffer,
  secret: string,
  nowMs: number,
): boolean => {
  if (typeof header !== 'string') return false;

  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const signedAtMs = Number(parsed.timestamp) * MS_PER_SECOND;
  if (Math.abs(nowMs - signedAtMs) > SIGNATURE_TOLERANCE_MS) return false;

  const expected = signatureOf(parsed.timestamp, rawBody, secret);

  return parsed.signatures.some((signature) =>
    isSameSignature(signature, expected),
  );
};

const signatureHeaderOf = (
  rawBody: Buffer,
  secret: string,
  nowMs: number,
): string => {
  const timestamp = String(Math.floor(nowMs / MS_PER_SECOND));

  return `ts=${timestamp};h1=${signatureOf(timestamp, rawBody, secret)}`;
};

export {
  isSignatureValid,
  parseSignatureHeader,
  SIGNATURE_TOLERANCE_MS,
  signatureHeaderOf,
};
export type { PaddleSignatureHeader };
