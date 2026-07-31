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

/** One join-table write that must commit atomically with the row it belongs to,
 *  given the open transaction scope and the written row's id. */
export type JoinWrite = (tx: TxScope, id: number) => Promise<void>;

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
  /** Join-table writes that must commit atomically with the row. Any present ⇒
   *  the row and every join write share one transaction, so a failed join write
   *  rolls the row write back rather than leaving partial state; an empty list ⇒
   *  the plain single-statement path. Run in order, inside that transaction. The
   *  caller no longer decides "am I transactional?" separately from which hooks
   *  run — the two can't drift. */
  joinWrites: readonly JoinWrite[];
  /** The plain insert/update, used when there are no join writes. */
  plainWrite: () => Promise<Row | null>;
  /** Read the just-committed row back — this MUST be pinned to the primary. A
   *  "read"-mode lookup can hit a replica that still lags the commit and return
   *  null for the row just written. Use `table.findByIdPrimary` or a
   *  primary-pinned join lookup. */
  readBack: (id: number) => Promise<Row | null>;
  /** The table being written, for the error raised when a create's own row can't
   *  be read back. */
  tableName: string;
}

/**
 * Read the just-committed row back. Null only for an update, whose row can be
 * deleted between the caller's lookup and the commit; a create's row is one it
 * just inserted, so not finding it is a broken database rather than an outcome
 * to hand back.
 */
const readBackWrittenOrNull = async <Row extends { id: number }>(
  { existingId, readBack, tableName }: EntityWrite<Row>,
  id: number,
): Promise<Row | null> => {
  const row = await readBack(id);
  if (row || existingId !== null) return row;
  throw new Error(
    `${tableName}: row ${id} was inserted but could not be read back`,
  );
};

/**
 * Write the row — transactionally with its join writes when there are any, else
 * as a plain single statement — read it back on the primary, then run
 * `afterCommit`. Returns the committed row, or null when the read-back finds
 * nothing — which only an update can legitimately do (its row was deleted before
 * the commit); a create that can't read its own row back throws
 * ({@link readBackWrittenOrNull}).
 */
export const writeEntity = async <Row extends { id: number }>(
  write: EntityWrite<Row>,
): Promise<Row | null> => {
  const row =
    write.joinWrites.length > 0
      ? await readBackWrittenOrNull(
          write,
          await writeRowInTransaction(
            await write.buildStatement(),
            write.existingId,
            async (tx, id) => {
              for (const joinWrite of write.joinWrites) await joinWrite(tx, id);
            },
          ),
        )
      : await write.plainWrite();
  if (row && write.afterCommit) await write.afterCommit(row.id);
  return row;
};
