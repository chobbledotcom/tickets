import { apiErrorResponse } from "#routes/api/cors.ts";
import { TransactionValidationError } from "#shared/db/client.ts";

export const transactionValidationMessageOrRethrow = (
  error: unknown,
): string => {
  if (error instanceof TransactionValidationError) {
    return error.message;
  }
  throw error;
};

/** Turns a validation conflict discovered inside a write transaction into JSON. */
export const writeEntityOrValidationResponse = async <
  Row extends { id: number },
>(
  write: () => Promise<Row | null>,
): Promise<{ row: Row | null } | { response: Response }> => {
  try {
    return { row: await write() };
  } catch (error) {
    return {
      response: apiErrorResponse(transactionValidationMessageOrRethrow(error)),
    };
  }
};
