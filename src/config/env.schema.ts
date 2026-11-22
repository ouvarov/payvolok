import { z } from 'zod';

// A blank KEY= line in .env means unset, not a value that fails the format check.
const blankAsUnset = (value: unknown): unknown =>
  value === '' ? undefined : value;

const optionalUnlessBlank = (pattern: RegExp) =>
  z.preprocess(blankAsUnset, z.string().regex(pattern).optional());

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, hostname: /.+/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  PUBLIC_BASE_URL: z
    .url({ protocol: /^https?$/, hostname: /.+/ })
    .transform((url) => url.replace(/\/+$/, '')),
  // Compared verbatim with the browser's Origin header, so it must already be in that form.
  WEB_ORIGIN: z
    .url({ protocol: /^https?$/, hostname: /.+/ })
    .refine((url) => URL.canParse(url) && new URL(url).origin === url, {
      message: 'Must be an origin such as https://app.example, without a path',
    }),
  FAKE_WEBHOOK_SECRET: z.string().min(32).optional(),
  PADDLE_API_KEY: optionalUnlessBlank(/^pdl_sdbx_apikey_\S+$/),
  PADDLE_WEBHOOK_SECRET: optionalUnlessBlank(/^pdl_ntfset_\S+$/),
  PADDLE_CLIENT_TOKEN: optionalUnlessBlank(/^test_[A-Za-z0-9]+$/),
  STRIPE_SECRET_KEY: optionalUnlessBlank(/^(sk|rk)_test_[A-Za-z0-9]+$/),
  STRIPE_WEBHOOK_SECRET: optionalUnlessBlank(/^whsec_[A-Za-z0-9]+$/),
  WEBHOOK_WORKER_ENABLED: z.stringbool().default(true),
  WEBHOOK_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(3600000)
    .default(5000),
  RECONCILIATION_WORKER_ENABLED: z.stringbool().default(true),
  RECONCILIATION_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(3600000)
    .default(15000),
  DEMO_TOKEN_SECRET: optionalUnlessBlank(/^\S{32,}$/),
  // Blank is the default, not 0: 0 turns demo payments off.
  DEMO_DAILY_PAYMENT_LIMIT: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(0).default(50),
  ),
  TRUST_PROXY_HOPS: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(0).max(5).default(0),
  ),
});

type Env = z.infer<typeof envSchema>;

// Apart from envSchema, whose .pick() the scripts use: a random per-process secret
// would make every restart in production void all live demo tokens.
const appEnvSchema = envSchema.superRefine((env, context) => {
  if (env.NODE_ENV === 'production' && env.DEMO_TOKEN_SECRET === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['DEMO_TOKEN_SECRET'],
      message: 'Required in production',
    });
  }
});

const validateEnv = (config: Record<string, unknown>): Env => {
  const result = appEnvSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
};

export { envSchema, validateEnv };
export type { Env };
