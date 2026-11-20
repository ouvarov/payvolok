import { randomUUID } from 'node:crypto';

import { envSchema } from '../src/config/env.schema';
import {
  ProviderError,
  type CreatePaymentInput,
} from '../src/providers/payment-provider.port';
import {
  RedactedSecret,
  type StripeCredentials,
} from '../src/providers/provider-credentials';
import {
  isOk,
  sendStripeRequest,
  STRIPE_API_VERSION,
  stripeErrorOf,
} from '../src/providers/stripe/stripe-http';
import { StripeProvider } from '../src/providers/stripe/stripe.provider';

const CHECK_AMOUNT_MINOR = 734;
const CHECK_REFUND_MINOR = 200;
const DESCRIPTION_MAX_LENGTH = 255;
const INVALID_SECRET_KEY = 'sk_test_payvolokInvalidOnPurpose0000';
const SUBSCRIBED_EVENTS = [
  'checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.completed',
  'checkout.session.expired',
];

type WebhookEndpoint = {
  url?: unknown;
  status?: unknown;
  api_version?: unknown;
  enabled_events?: unknown;
};

const testCredentialsOf = (secretKey: string): StripeCredentials => ({
  provider: 'stripe',
  secretKey: new RedactedSecret(secretKey),
  webhookSecrets: [],
});

const paymentInputWith = (
  overrides: Partial<CreatePaymentInput> = {},
): CreatePaymentInput => ({
  reference: randomUUID(),
  amountMinor: CHECK_AMOUNT_MINOR,
  currency: 'USD',
  description: 'payvolok stripe sandbox check',
  returnUrl: 'https://payvolok.example.test/return',
  webhookUrl: 'https://payvolok.example.test/webhooks/stripe',
  ...overrides,
});

const describeFailure = (error: unknown): string =>
  error instanceof ProviderError
    ? `${error.kind}: ${error.message}\n${JSON.stringify(error.cause, null, 2)}`
    : `unexpected: ${error instanceof Error ? error.name : 'unknown'}`;

const step = async <Result>(
  name: string,
  work: () => Promise<Result>,
): Promise<Result | null> => {
  try {
    const result = await work();
    console.log(`\n# ${name}: ok\n${JSON.stringify(result, null, 2)}`);

    return result;
  } catch (error) {
    console.log(`\n# ${name}: failed\n${describeFailure(error)}`);

    return null;
  }
};

const checkInvalidKey = async (provider: StripeProvider): Promise<void> => {
  try {
    await provider.createPayment(
      testCredentialsOf(INVALID_SECRET_KEY),
      paymentInputWith(),
    );
    console.log('\n# invalid key: unexpectedly accepted');
  } catch (error) {
    const printed = describeFailure(error);
    console.log(`\n# invalid key\n${printed}`);
    console.log(
      `key in the output: ${printed.includes(INVALID_SECRET_KEY) ? 'YES, fix it' : 'no'}`,
    );
  }
};

// Lists the destinations only: creating one would print its signing secret.
const checkWebhookEndpoints = async (secretKey: string): Promise<void> => {
  const response = await sendStripeRequest(
    fetch,
    new RedactedSecret(secretKey),
    { method: 'GET', path: '/v1/webhook_endpoints' },
  );
  if (!isOk(response)) throw stripeErrorOf(response);

  const { data } = response.body as { data: WebhookEndpoint[] };
  for (const endpoint of data) {
    const events = Array.isArray(endpoint.enabled_events)
      ? [...(endpoint.enabled_events as string[])].sort()
      : [];
    console.log(
      JSON.stringify(
        {
          url: endpoint.url,
          status: endpoint.status,
          apiVersion: endpoint.api_version,
          isPinnedVersion: endpoint.api_version === STRIPE_API_VERSION,
          hasExactlyTheFourEvents:
            JSON.stringify(events) === JSON.stringify(SUBSCRIBED_EVENTS),
        },
        null,
        2,
      ),
    );
  }
};

const runUnpaidChecks = async (
  provider: StripeProvider,
  credentials: StripeCredentials,
  secretKey: string,
): Promise<void> => {
  const created = await step('create a USD payment', () =>
    provider.createPayment(credentials, paymentInputWith()),
  );
  if (created) {
    console.log(
      `\nOpen to pay with 4242 4242 4242 4242: ${created.redirectUrl}`,
    );
    console.log(
      `Then run: ... scripts/stripe-sandbox-check.ts paid ${created.providerPaymentId}`,
    );
    await step('payment status', () =>
      provider.getStatus(credentials, {
        resource: 'payment',
        providerPaymentId: created.providerPaymentId,
      }),
    );
    await step('refund the unpaid payment', () =>
      provider.refund(credentials, {
        reference: randomUUID(),
        providerPaymentId: created.providerPaymentId,
        amountMinor: CHECK_REFUND_MINOR,
        currency: 'USD',
      }),
    );
  }

  await step('create a UAH payment', () =>
    provider.createPayment(credentials, paymentInputWith({ currency: 'UAH' })),
  );
  await step('refuse GBP locally', () =>
    provider.createPayment(credentials, paymentInputWith({ currency: 'GBP' })),
  );
  await step('create with a 255-character description', () =>
    provider.createPayment(
      credentials,
      paymentInputWith({ description: 'd'.repeat(DESCRIPTION_MAX_LENGTH) }),
    ),
  );
  await checkInvalidKey(provider);
  await step('webhook destinations', () => checkWebhookEndpoints(secretKey));
};

const runPaidChecks = async (
  provider: StripeProvider,
  credentials: StripeCredentials,
  secretKey: string,
  sessionId: string,
): Promise<void> => {
  const status = await step('paid payment status', () =>
    provider.getStatus(credentials, {
      resource: 'payment',
      providerPaymentId: sessionId,
    }),
  );
  const refund = await step('partial refund', () =>
    provider.refund(credentials, {
      reference: randomUUID(),
      providerPaymentId: sessionId,
      amountMinor: CHECK_REFUND_MINOR,
      currency: 'USD',
    }),
  );
  await step('list refunds', () =>
    provider.listRefunds(credentials, sessionId),
  );
  if (status) {
    await step('refund the remaining amount plus one', () =>
      provider.refund(credentials, {
        reference: randomUUID(),
        providerPaymentId: sessionId,
        amountMinor: status.amountMinor - CHECK_REFUND_MINOR + 1,
        currency: 'USD',
      }),
    );
  }
  if (refund) {
    await step('refund status', () =>
      provider.getStatus(credentials, {
        resource: 'refund',
        providerPaymentId: sessionId,
        providerRefundId: refund.providerRefundId,
        reference: randomUUID(),
      }),
    );
  }

  const fresh = await step('create a payment to expire', () =>
    provider.createPayment(credentials, paymentInputWith()),
  );
  if (!fresh) return;

  await step('expire it', async () => {
    const response = await sendStripeRequest(
      fetch,
      new RedactedSecret(secretKey),
      {
        method: 'POST',
        path: `/v1/checkout/sessions/${fresh.providerPaymentId}/expire`,
        form: {},
      },
    );
    if (!isOk(response)) throw stripeErrorOf(response);

    return provider.getStatus(credentials, {
      resource: 'payment',
      providerPaymentId: fresh.providerPaymentId,
    });
  });
};

const runSandboxCheck = async (): Promise<void> => {
  const { STRIPE_SECRET_KEY } = envSchema
    .pick({ STRIPE_SECRET_KEY: true })
    .parse(process.env);
  if (!STRIPE_SECRET_KEY) throw new Error('Set STRIPE_SECRET_KEY in .env');

  const provider = new StripeProvider();
  const credentials = testCredentialsOf(STRIPE_SECRET_KEY);
  const [phase, sessionId] = process.argv.slice(2);

  if (phase === 'paid' && sessionId) {
    await runPaidChecks(provider, credentials, STRIPE_SECRET_KEY, sessionId);
    return;
  }

  await runUnpaidChecks(provider, credentials, STRIPE_SECRET_KEY);
};

runSandboxCheck().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
