import { z } from 'zod';

const UNIQUE_VIOLATION_CODE = '23505';

const uniqueViolationSchema = z.object({
  cause: z.object({
    code: z.literal(UNIQUE_VIOLATION_CODE),
    constraint_name: z.string(),
  }),
});

const isUniqueViolationOf = (
  error: unknown,
  constraintName: string,
): boolean => {
  const violation = uniqueViolationSchema.safeParse(error);

  return (
    violation.success && violation.data.cause.constraint_name === constraintName
  );
};

export { isUniqueViolationOf };
