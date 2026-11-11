import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WebhookRequest } from '../../payment-provider.port';
import { signatureHeaderOf } from '../paddle-signature';

type PaddleTransactionFixture = {
  id: string;
  status: string;
  currency_code: string;
  custom_data: Record<string, unknown> | null;
  subscription_id: string | null;
  details: {
    totals: { total: string; grand_total: string };
    line_items: { id: string }[];
  };
  payments?: { error_code: string | null }[];
  checkout?: { url: string | null } | null;
};

type PaddleAdjustmentFixture = {
  id: string;
  action: string;
  status: string;
  transaction_id: string;
  subscription_id: string | null;
  currency_code: string;
  totals: { total: string };
};

type PaddleEventFixture<Data> = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: Data;
};

type PaddleResponseFixture<Data> = {
  data: Data;
  meta: { request_id: string };
};

type TransactionEventName =
  | 'event-transaction-completed'
  | 'event-transaction-payment-failed'
  | 'event-transaction-canceled'
  | 'event-transaction-paid';

type AdjustmentEventName =
  | 'event-adjustment-created'
  | 'event-adjustment-updated-approved'
  | 'event-adjustment-updated-rejected';

type ErrorBodyName =
  | 'invalid_field'
  | 'transaction_default_checkout_url_not_set'
  | 'invalid_token'
  | 'forbidden'
  | 'not_found'
  | 'too_many_requests'
  | 'internal_error';

const PADDLE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PADDLE_ID_LENGTH = 26;
const PADDLE_SIGNATURE_HEADER = 'paddle-signature';

const fixtureTextOf = (fileName: string): string =>
  readFileSync(join(__dirname, fileName), 'utf8');

const jsonFixtureOf = <Fixture>(name: string): Fixture =>
  JSON.parse(fixtureTextOf(`${name}.json`)) as Fixture;

const transactionEventFixture = (
  name: TransactionEventName,
): PaddleEventFixture<PaddleTransactionFixture> => jsonFixtureOf(name);

const adjustmentEventFixture = (
  name: AdjustmentEventName,
): PaddleEventFixture<PaddleAdjustmentFixture> => jsonFixtureOf(name);

const transactionResponseFixture = (
  name: 'transaction-created' | 'transaction-completed',
): PaddleResponseFixture<PaddleTransactionFixture> => jsonFixtureOf(name);

const adjustmentResponseFixture =
  (): PaddleResponseFixture<PaddleAdjustmentFixture> =>
    jsonFixtureOf('adjustment-created');

const adjustmentListFixture = (): PaddleResponseFixture<
  PaddleAdjustmentFixture[]
> & {
  meta: { pagination: { per_page: number; next: string; has_more: boolean } };
} => jsonFixtureOf('adjustment-list');

const errorBodyFixture = (name: ErrorBodyName): unknown =>
  jsonFixtureOf<Record<ErrorBodyName, unknown>>('error-bodies')[name];

const forbiddenHtmlFixture = (): string => fixtureTextOf('forbidden.html');

const syntheticPaddleId = (prefix: string): string =>
  `${prefix}_${Array.from(
    { length: PADDLE_ID_LENGTH },
    () => PADDLE_ID_ALPHABET[randomInt(PADDLE_ID_ALPHABET.length)],
  ).join('')}`;

const signedPaddleWebhook = (
  body: unknown,
  secret: string,
  nowMs: number,
): WebhookRequest => {
  const rawBody = Buffer.from(JSON.stringify(body));

  return {
    rawBody,
    headers: {
      [PADDLE_SIGNATURE_HEADER]: signatureHeaderOf(rawBody, secret, nowMs),
    },
  };
};

export {
  adjustmentEventFixture,
  adjustmentListFixture,
  adjustmentResponseFixture,
  errorBodyFixture,
  forbiddenHtmlFixture,
  PADDLE_SIGNATURE_HEADER,
  signedPaddleWebhook,
  syntheticPaddleId,
  transactionEventFixture,
  transactionResponseFixture,
};
export type {
  ErrorBodyName,
  PaddleAdjustmentFixture,
  PaddleEventFixture,
  PaddleResponseFixture,
  PaddleTransactionFixture,
};
