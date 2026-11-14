import { TransactionValidationError } from "#db/transaction.ts";

export const transactionValidationMessageOrRethrow = (
  error: unknown,
): string => {
  if (error instanceof TransactionValidationError) {
    return error.message;
  }
  throw error;
};
