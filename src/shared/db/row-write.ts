/**
 * One row write and its coupled side writes, committed in one transaction.
 */

import type { InStatement } from "@libsql/client";
import {
  insertedRowId,
  type TransactionStateReader,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import { namedError } from "#shared/named-error.ts";

/** An update found no row to change: something deleted the row after the
 *  caller looked it up. */
export class UpdatedRowMissingError extends namedError(
  "UpdatedRowMissingError",
) {}

/**
 * Write one row `statement` in a fresh write transaction. Run `persist`, the
 * coupled join-table writes, on the same `tx`, so the row and its side writes
 * commit or roll back together. On update, the optional `readState` step runs
 * before the statement. It reads the state that reaches `persist`, and it can
 * refuse the write with a throw. A create skips it. An update that changes no
 * row throws {@link UpdatedRowMissingError} before `persist`, so a deleted row
 * gets no side writes. Returns the row id.
 */
export const writeRowInTransaction = <State = never>(
  statement: InStatement,
  existingId: number | null,
  persist: (tx: TxScope, id: number, state: State | null) => Promise<void>,
  readState?: TransactionStateReader<State>,
): Promise<number> =>
  withTransaction(async (tx) => {
    const state =
      existingId !== null && readState ? await readState(tx, existingId) : null;
    const res = await tx.execute(statement);
    // An UPDATE with RETURNING reports no affected rows, so a returned row
    // also counts as a change.
    if (
      existingId !== null &&
      res.rowsAffected === 0 &&
      res.rows.length === 0
    ) {
      throw new UpdatedRowMissingError(`No row ${existingId} to update`);
    }
    const id = existingId ?? insertedRowId(res);
    await persist(tx, id, state);
    return id;
  });
