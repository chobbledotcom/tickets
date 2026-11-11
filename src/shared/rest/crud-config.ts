/** The shared config shapes resource modules spread into `defineCrudApi`.
 *  They keep the repeated keys out of each resource and put the differing
 *  facts in route order. */

import type { InValue } from "@libsql/client";
import type { Table } from "#db/table.ts";
import { OWNER_API } from "#routes/auth.ts";

/** The write config an owner-only catalog resource shares. It holds every row,
 *  the replica and primary reads, the name field, the delete, its side effect,
 *  and the table. The resource adds only its own handlers and mappers. */
export const ownerCatalogConfig = <
  Row,
  Input,
  FullRow extends Row,
  NameField extends keyof FullRow & string,
>(
  getAll: () => Promise<FullRow[]>,
  lookup: (id: number) => Promise<FullRow | null>,
  lookupAfterWrite: (id: number) => Promise<FullRow | null>,
  nameField: NameField,
  onDelete: (id: InValue) => Promise<void>,
  table: Table<Row, Input>,
) => ({
  getAll,
  lookup,
  lookupAfterWrite,
  nameField,
  onDelete,
  policy: OWNER_API,
  table,
});
