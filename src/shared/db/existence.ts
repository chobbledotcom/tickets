import { queryAll, resultRows } from "#db/client.ts";
import type { FillableRead } from "#db/fill-together.ts";
import type { TableName } from "#db/select/tables.ts";
import type { SqlStatement } from "#db/sql.ts";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { requestCache } from "#shared/request-cache.ts";

/** A cached "does this table hold a row?" probe, with the batched read the
 *  public nav uses. A write to the table clears the answer. */
export type ExistenceProbe = {
  readonly read: FillableRead;
  readonly exists: () => Promise<boolean>;
};

export const existenceProbe = (
  table: TableName,
  statement: SqlStatement,
): ExistenceProbe => {
  const cache = requestCache(() => queryAll<{ id: number }>(statement));
  registerTableInvalidation([table], cache.invalidate);
  return {
    exists: async () => (await cache.getAll()).length > 0,
    read: {
      fill: (result) => cache.prime(resultRows<{ id: number }>(result)),
      statement,
    },
  };
};
