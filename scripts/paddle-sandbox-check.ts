import { randomUUID } from 'node:crypto';

import { envSchema } from '../src/config/env.schema';
import { PaddleProvider } from '../src/providers/paddle/paddle.provider';
import {
  ProviderError,
  type CreatePaymentInput,
} from '../src/providers/payment-provider.port';

const CHECK_AMOUNT_MINOR = 1000;
const CHECK_REFUND_MINOR = 400;
const INVALID_API_KEY = 'pdl_sdbx_apikey_payvolok_invalid_on_purpose';

const paymentInputWith = (
  overrides: Partial<CreatePaymentInput> = {},
): CreatePaymentInput => ({
  reference: randomUUID(),
  amountMinor: CHECK_AMOUNT_MINOR,
  currency: 'USD',
  description: 'payvolok sandbox check',
  returnUrl: 'https://payvolok.example.test/return',
  webhookUrl: 'https://payvolok.example.test/webhooks/paddle',
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

const runSandboxCheck = async (): Promise<void> => {
  const { PADDLE_API_KEY } = envSchema
    .pick({ PADDLE_API_KEY: true })
    .parse(process.env);
  if (!PADDLE_API_KEY) throw new Error('Set PADDLE_API_KEY in .env');

  const provider = new PaddleProvider({
    apiKey: PADDLE_API_KEY,
    webhookSecret: null,
  });

  const created = await step('create payment', () =>
    provider.createPayment(paymentInputWith()),
  );
  if (created) {
    console.log(`\nOpen to pay: ${created.redirectUrl}`);
    await step('payment status', () =>
      provider.getStatus({
        resource: 'payment',
        providerPaymentId: created.providerPaymentId,
      }),
    );
    await step('refund an unpaid payment', () =>
      provider.refund({
        reference: randomUUID(),
        providerPaymentId: created.providerPaymentId,
        amountMinor: CHECK_REFUND_MINOR,
        currency: 'USD',
      }),
    );
  }

  await step('unsupported currency', () =>
    provider.createPayment(paymentInputWith({ currency: 'XXX' })),
  );
  await step('empty description', () =>
    provider.createPayment(paymentInputWith({ description: '' })),
  );
  await step('invalid API key', () =>
    new PaddleProvider({
      apiKey: INVALID_API_KEY,
      webhookSecret: null,
    }).createPayment(paymentInputWith()),
  );
};

runSandboxCheck().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
