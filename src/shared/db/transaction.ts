import { resultRows, type SqlStatement, type TxScope } from "#db/client.ts";
import { namedError } from "#shared/named-error.ts";

/** Runs a transaction-local ID lookup for one deduplicated input set. */
export const txIdSet = async (
  tx: TxScope,
  ids: readonly number[],
  toStatement: (uniqueIds: number[]) => SqlStatement,
): Promise<Set<number>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = resultRows<{ id: number }>(
    await tx.execute(toStatement(unique)),
  );
  return new Set(rows.map((row) => row.id));
};

/** An expected validation failure found after a write transaction starts. */
export class TransactionValidationError extends namedError(
  "TransactionValidationError",
) {}
