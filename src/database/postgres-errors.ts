import { z } from 'zod';

const UNIQUE_VIOLATION_CODE = '23505';
const CHECK_VIOLATION_CODE = '23514';
const DATA_EXCEPTION_CLASS = '22';

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

// The same data fails the same way on every attempt, so a retry cannot help.
const isPermanentDataError = (error: unknown): boolean => {
  const code = postgresCodeOf(error);

  return (
    code !== null &&
    (code.startsWith(DATA_EXCEPTION_CLASS) || code === CHECK_VIOLATION_CODE)
  );
};

// Only the class and the pg code: a DrizzleQueryError message carries the query params.
const describeError = (error: unknown): string => {
  const errorClass =
    error instanceof Error ? error.constructor.name : 'unknown';
  const code = postgresCodeOf(error);

  return code ? `${errorClass} ${code}` : errorClass;
};

export {
  describeError,
  isPermanentDataError,
  isUniqueViolationOf,
  postgresCodeOf,
};
