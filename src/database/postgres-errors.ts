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

const postgresCodeSchema = z.object({ cause: z.object({ code: z.string() }) });

const postgresCodeOf = (error: unknown): string | null => {
  const parsed = postgresCodeSchema.safeParse(error);

  return parsed.success ? parsed.data.cause.code : null;
};

export { isUniqueViolationOf, postgresCodeOf };
