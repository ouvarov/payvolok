import { z } from 'zod';

// A blank KEY= line in .env means unset, not a value that fails the format check.
const optionalUnlessBlank = (pattern: RegExp) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(pattern).optional(),
  );

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, hostname: /.+/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  API_KEY_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
  PUBLIC_BASE_URL: z
    .url({ protocol: /^https?$/, hostname: /.+/ })
    .transform((url) => url.replace(/\/+$/, '')),
  FAKE_WEBHOOK_SECRET: z.string().min(32).optional(),
  PADDLE_API_KEY: optionalUnlessBlank(/^pdl_sdbx_apikey_\S+$/),
  PADDLE_WEBHOOK_SECRET: optionalUnlessBlank(/^pdl_ntfset_\S+$/),
  PADDLE_CLIENT_TOKEN: optionalUnlessBlank(/^test_[A-Za-z0-9]+$/),
  WEBHOOK_WORKER_ENABLED: z.stringbool().default(true),
  WEBHOOK_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(3600000)
    .default(5000),
});

type Env = z.infer<typeof envSchema>;

const validateEnv = (config: Record<string, unknown>): Env => {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
};

export { envSchema, validateEnv };
export type { Env };
