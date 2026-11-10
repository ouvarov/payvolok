import { z } from 'zod';

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
