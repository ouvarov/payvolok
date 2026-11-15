import type { Payment } from '@/database/schemas/payments.schema';

// Migration 0010 gives every row an account and 0011 makes the column NOT NULL; this goes with it.
const accountIdOf = (
  payment: Pick<Payment, 'id' | 'providerAccountId'>,
): string => {
  if (payment.providerAccountId === null) {
    throw new Error(`Payment ${payment.id} has no provider account`);
  }

  return payment.providerAccountId;
};

export { accountIdOf };
