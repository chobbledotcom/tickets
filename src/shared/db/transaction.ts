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

/** Stops the containing write when a check has something to say about it.
 *  A check that finds nothing wrong answers null, and the write carries on. */
export const refuseTheWriteOn = (error: string | null): void => {
  if (error) throw new TransactionValidationError(error);
};

/** The same check, wrapped so the caller runs it and stops on what it finds. */
export const refusingTheWriteOn =
  <TArgs extends unknown[]>(
    check: (...args: TArgs) => Promise<string | null>,
  ): ((...args: TArgs) => Promise<void>) =>
  async (...args) =>
    refuseTheWriteOn(await check(...args));
