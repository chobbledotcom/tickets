/** The batched write the schema sync steps share: the creates next to the
 *  drops of project-owned names the schema no longer declares. One batched
 *  write, one subrequest. */

import { executeBatch, type SqlStatement } from "#db/client.ts";

/** Wrap one SQL string as a no-argument batch statement. */
export const writeStatement = (sql: string): SqlStatement => ({
  args: [],
  sql,
});

/** Batch the creates with the drops. The sqlite_autoindex_* entries backing
 *  UNIQUE/PRIMARY KEY constraints never carry a project prefix, so a caller
 *  filters those out by prefix and they stay untouched. */
export const batchCreatesWithDrops = (
  creates: SqlStatement[],
  liveNames: Iterable<string>,
  prefix: string,
  declared: Set<string>,
  dropSql: (name: string) => string,
): Promise<void> => {
  const statements = [
    ...creates,
    ...[...liveNames]
      .filter((name) => name.startsWith(prefix) && !declared.has(name))
      .map((name) => writeStatement(dropSql(name))),
  ];
  if (statements.length === 0) return Promise.resolve();
  return executeBatch(statements);
};
