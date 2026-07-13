/**
 * The shared write step behind both REST factories (`defineResource` and
 * `defineCrudApi`): write one row — transactionally when it has join-table
 * writes that must commit atomically with it, else as a plain single statement —
 * read the committed row back on the primary, then run the post-commit hook.
 *
 * The two factories differ at their edges (a form vs a JSON body in front, a
 * `Result` vs an HTTP `Response` behind), but the write itself is one sequence,
 * kept here so the read-your-writes invariant on the read-back lives in exactly
 * one place.
 */

import {
  type SqlStatement,
  type TxScope,
  writeRowInTransaction,
} from "#shared/db/client.ts";

/** How to write one row and read it back. `existingId` is null on create (the id
 *  comes from the INSERT) and the row id on update. */
export interface EntityWrite<Row extends { id: number }> {
  /** Post-commit hook keyed on the written row's id — for reconciling a derived
   *  table the transactional statement path would otherwise bypass. Runs after
   *  the read-back. */
  afterCommit?: ((id: number) => Promise<void>) | undefined;
  /** Build the INSERT/UPDATE statement — only called on the transactional path. */
  buildStatement: () => Promise<SqlStatement>;
  existingId: number | null;
  /** Join-table writes to run inside the row's own transaction, so a failure
   *  rolls the row write back rather than leaving partial state. */
  joinWrite: (tx: TxScope, id: number) => Promise<void>;
  /** The plain insert/update, used when there are no join writes. */
  plainWrite: () => Promise<Row | null>;
  /** Read the just-committed row back — this MUST be pinned to the primary. A
   *  "read"-mode lookup can hit a replica that still lags the commit and return
   *  null for the row just written, which the create path would then dereference
   *  (`row.id`) and crash on. Use `table.findByIdPrimary` or a primary-pinned
   *  join lookup. */
  readBack: (id: number) => Promise<Row | null>;
  /** True when a join-table write must share the row's transaction; false takes
   *  the plain single-statement path. */
  transactional: boolean;
}

/**
 * Write the row (transactionally or plainly), read it back on the primary, then
 * run `afterCommit`. Returns the committed row, or null when the read-back finds
 * nothing (a plain write returning null, or an update whose id no longer exists).
 */
export const writeEntity = async <Row extends { id: number }>(
  write: EntityWrite<Row>,
): Promise<Row | null> => {
  const row = write.transactional
    ? await write.readBack(
        await writeRowInTransaction(
          await write.buildStatement(),
          write.existingId,
          write.joinWrite,
        ),
      )
    : await write.plainWrite();
  if (row && write.afterCommit) await write.afterCommit(row.id);
  return row;
};
