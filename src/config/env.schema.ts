import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, hostname: /.+/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  FAKE_WEBHOOK_SECRET: z.string().min(32).optional(),
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
