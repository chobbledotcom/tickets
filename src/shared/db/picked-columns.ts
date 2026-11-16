// effects: pure
/**
 * Columns that a read written by hand picks by name, such as a read with a
 * CTE or a UNION that the builder does not write. The client decodes each
 * picked column through its codec, as it does for a builder read.
 */

import { withSources } from "#db/select/sources.ts";
import { type SqlStatement, sql, sqlCommas, sqlName } from "#db/sql.ts";

/** The picked columns of a hand-written read. */
export type PickedColumns = Readonly<{
  /** The SELECT list: each column under its name. */
  list: SqlStatement;
  /** Mark the read that selects `list`, so the client decodes its rows. */
  decoded: <Statement extends SqlStatement>(statement: Statement) => Statement;
}>;

/** Pick each column under its name. Take each column from `tableNode`, so
 *  that it names its table. */
export const pickedColumns = (
  picked: Readonly<Record<string, SqlStatement>>,
): PickedColumns => {
  const entries = Object.entries(picked);
  return {
    decoded: (statement) => withSources(statement, entries),
    list: sqlCommas(
      entries.map(([name, value]) => sql`${value} AS ${sqlName(name)}`),
    ),
  };
};
