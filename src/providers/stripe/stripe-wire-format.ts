import { z } from 'zod';

const stripeErrorBodySchema = z.object({
  error: z.object({
    type: z.string(),
    code: z.string().nullish(),
    message: z.string().nullish(),
  }),
});

type StripeErrorBody = z.infer<typeof stripeErrorBodySchema>;

const parseJsonOrNull = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export { parseJsonOrNull, stripeErrorBodySchema };
export type { StripeErrorBody };
