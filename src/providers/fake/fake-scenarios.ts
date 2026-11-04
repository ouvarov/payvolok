import { z } from 'zod';

import type {
  ProviderPaymentStatus,
  ProviderRefundStatus,
} from '../payment-provider.port';
import type {
  ProviderPaymentEvent,
  ProviderRefundEvent,
} from '../provider-events';

type FakePaymentScenario = {
  eventTypes: readonly ProviderPaymentEvent['type'][];
  finalStatus: ProviderPaymentStatus;
};

type FakeRefundScenario = {
  eventTypes: readonly ProviderRefundEvent['type'][];
  finalStatus: ProviderRefundStatus;
};

const SCENARIO_AMOUNT_MODULUS = 100;

const DEFAULT_PAYMENT_SCENARIO: FakePaymentScenario = {
  eventTypes: ['payment.pending', 'payment.succeeded'],
  finalStatus: 'succeeded',
};

const PAYMENT_SCENARIOS_BY_SUFFIX: ReadonlyMap<number, FakePaymentScenario> =
  new Map<number, FakePaymentScenario>([
    [
      1,
      {
        eventTypes: ['payment.pending', 'payment.failed'],
        finalStatus: 'failed',
      },
    ],
    [
      2,
      {
        eventTypes: [
          'payment.pending',
          'payment.attempt_failed',
          'payment.succeeded',
        ],
        finalStatus: 'succeeded',
      },
    ],
    [
      3,
      {
        eventTypes: [
          'payment.pending',
          'payment.attempt_failed',
          'payment.failed',
        ],
        finalStatus: 'failed',
      },
    ],
    [
      4,
      {
        eventTypes: ['payment.pending', 'payment.expired'],
        finalStatus: 'expired',
      },
    ],
    [5, { eventTypes: ['payment.pending'], finalStatus: 'pending' }],
  ]);

const DEFAULT_REFUND_SCENARIO: FakeRefundScenario = {
  eventTypes: ['refund.pending', 'refund.succeeded'],
  finalStatus: 'succeeded',
};

const REFUND_SCENARIOS_BY_SUFFIX: ReadonlyMap<number, FakeRefundScenario> =
  new Map<number, FakeRefundScenario>([
    [
      1,
      {
        eventTypes: ['refund.pending', 'refund.failed'],
        finalStatus: 'failed',
      },
    ],
    [5, { eventTypes: ['refund.pending'], finalStatus: 'pending' }],
  ]);

const paymentScenarioFor = (amountMinor: number): FakePaymentScenario =>
  PAYMENT_SCENARIOS_BY_SUFFIX.get(amountMinor % SCENARIO_AMOUNT_MODULUS) ??
  DEFAULT_PAYMENT_SCENARIO;

const refundScenarioFor = (amountMinor: number): FakeRefundScenario =>
  REFUND_SCENARIOS_BY_SUFFIX.get(amountMinor % SCENARIO_AMOUNT_MODULUS) ??
  DEFAULT_REFUND_SCENARIO;

const amountMinorSchema = z.int().nonnegative();
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

const fakePaymentIdentitySchema = z.strictObject({
  reference: z.string(),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
});

const fakeRefundIdentitySchema = z.strictObject({
  reference: z.string(),
  providerPaymentId: z.string(),
  amountMinor: z.int().positive(),
  currency: currencySchema,
});

type FakePaymentIdentity = z.infer<typeof fakePaymentIdentitySchema>;
type FakeRefundIdentity = z.infer<typeof fakeRefundIdentitySchema>;

const encodeFakeId = (identity: FakePaymentIdentity | FakeRefundIdentity) =>
  Buffer.from(JSON.stringify(identity)).toString('base64url');

const parseJsonOrNull = (rawJson: Buffer): unknown => {
  try {
    return JSON.parse(rawJson.toString('utf8'));
  } catch {
    return null;
  }
};

const decodeFakePaymentId = (id: string): FakePaymentIdentity | null => {
  const parsed = fakePaymentIdentitySchema.safeParse(
    parseJsonOrNull(Buffer.from(id, 'base64url')),
  );

  return parsed.success ? parsed.data : null;
};

const decodeFakeRefundId = (id: string): FakeRefundIdentity | null => {
  const parsed = fakeRefundIdentitySchema.safeParse(
    parseJsonOrNull(Buffer.from(id, 'base64url')),
  );

  return parsed.success ? parsed.data : null;
};

const fakeWirePaymentEventSchema = z.object({
  type: z.enum([
    'payment.pending',
    'payment.attempt_failed',
    'payment.succeeded',
    'payment.failed',
    'payment.expired',
  ]),
  reference: z.string().nullable(),
  providerPaymentId: z.string().min(1),
  providerSubscriptionId: z.string().nullable(),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  failureReason: z.string().nullable(),
});

const fakeWireRefundEventSchema = z.object({
  type: z.enum(['refund.pending', 'refund.succeeded', 'refund.failed']),
  providerPaymentId: z.string().min(1),
  reference: z.string().nullable(),
  refundReference: z.string().nullable(),
  providerRefundId: z.string().nullable(),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
});

const fakeWireSubscriptionEventSchema = z.object({
  type: z.enum([
    'subscription.activated',
    'subscription.past_due',
    'subscription.paused',
    'subscription.canceled',
    'subscription.expired',
  ]),
  reference: z.string().nullable(),
  providerSubscriptionId: z.string().min(1),
  providerStatus: z.string(),
  currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(),
});

const fakeWireEventSchema = z.discriminatedUnion('type', [
  fakeWirePaymentEventSchema,
  fakeWireRefundEventSchema,
  fakeWireSubscriptionEventSchema,
]);

const fakeWireEventTypeSchema = z.object({ type: z.string() });

const fakeWireBodySchema = z.object({
  eventId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  events: z.array(z.unknown()).min(1),
});

type FakeWireBody = {
  eventId: string;
  occurredAt: string | null;
  events: readonly unknown[];
};

export {
  decodeFakePaymentId,
  decodeFakeRefundId,
  encodeFakeId,
  fakePaymentIdentitySchema,
  fakeWireBodySchema,
  fakeWireEventSchema,
  fakeWireEventTypeSchema,
  parseJsonOrNull,
  paymentScenarioFor,
  refundScenarioFor,
};
export type { FakeWireBody };
