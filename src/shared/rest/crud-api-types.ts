/** Type definitions for the CRUD API factory, extracted so the factory file
 *  stays under the line target. See {@link crud-api.ts} for the factory itself. */

import type { InValue } from "@libsql/client";
import type { AuthPolicy } from "#routes/auth.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import type { TransactionStateReader, TxScope } from "#shared/db/client.ts";
import type { Table } from "#shared/db/table.ts";
import type { Result } from "#shared/result.ts";
import type { AdminSession } from "#shared/types.ts";

/** An atomic body-only side effect (e.g. relationship edges) for a create/update.
 *  Two-phase so the whole write is all-or-nothing:
 *  `validate` runs BEFORE the write and either rejects (400, nothing written) or
 *  yields a prepared `value`; `persist` then runs in the SAME transaction as the
 *  row write, so a failure rolls the row write back too — never an orphan row
 *  without its side effect. A resource with no side effects omits it and takes
 *  the plain (untransacted) single-statement path. */
export interface CrudSideEffect<Input, FullRow, Prepared, State = never> {
  /** Persist the prepared value on the open write transaction `tx`, given the
   *  written row's `id` and narrow pre-update state. A throw rolls back the row
   *  write with it. */
  persist: (
    tx: TxScope,
    id: number,
    value: Prepared,
    state: State | null,
  ) => Promise<void>;
  /** Validate the side effect against the would-be `input` (the post-save row
   *  fields), the raw `body`, and the `existing` full row on update (null on
   *  create). Returns `{ error }` to reject the whole write, or `{ value }` with
   *  the prepared data to persist once the row exists. */
  validate: (
    input: Input,
    body: Record<string, unknown>,
    existing: FullRow | null,
  ) => Promise<{ error: string } | { value: Prepared }>;
}

/** The post-commit hook shared by every write-config: it runs after a
 *  create/update has committed and the row has been re-read, keyed on the row
 *  id. Unlike `afterWrite` (which shares the write transaction), this fires
 *  post-commit — for reconciling a derived table (e.g. listing_prices) that the
 *  transactional `insertStatement`/`updateStatement` path would otherwise
 *  bypass. */
export interface AfterCommitConfig {
  afterCommit?: (id: number) => Promise<void>;
}

/** A join-table write run inside the row's write transaction, given the open
 *  transaction scope, the written row's id, parsed input, and narrow pre-update
 *  state (null on create or when no reader is configured). */
export type AfterWriteHook<Input, State = never> = (
  tx: TxScope,
  id: number,
  input: Input,
  state: State | null,
) => Promise<void>;

/** Configuration for defineCrudApi */
export interface CrudApiConfig<
  Row,
  Input,
  FullRow extends Row = Row,
  Prepared = void,
  State = never,
> extends AfterCommitConfig {
  /** Side-effect run with the written row's id and the parsed input to persist
   *  join-table rows (a listing's groups, a group's package members) that live
   *  outside the main table. Runs inside the SAME transaction as the row write
   *  (it receives the transaction scope), so a failure rolls the row write back
   *  rather than leaving partial state. */
  afterWrite?: AfterWriteHook<Input, State>;
  /** Extra route entries to merge in (can also override generated routes) */
  extraRoutes?: Record<string, RouteHandlerFn>;
  /** Every row, from cache. May carry more than the table, such as counts. */
  getAll: () => Promise<FullRow[]>;
  /** Optionally hydrate response rows in one batched call, keyed by row id. A
   *  single-row response passes an array of one through this same path. */
  hydrate?: (
    rows: FullRow[],
  ) => Promise<ReadonlyMap<number, Record<string, unknown>>>;
  /** When true, activity log entries for create/update are linked to the row's id as listing_id */
  linkActivityToRow?: boolean;
  /** Extra keys added to the list response alongside the row array (e.g. admin_level) */
  listExtras?: (session: AdminSession) => Record<string, unknown>;
  /** Custom single-row lookup. Defaults to reading the row by its key. */
  lookup?: (id: number) => Promise<FullRow | null>;
  /** Custom single-row lookup used ONLY to read a row back right after committing
   *  its own write, which must be pinned to the primary (read-your-writes): the
   *  default `lookup` runs in "read" mode and can hit a replica that lags the
   *  commit, returning null for the just-written row and crashing on `.id`.
   *  Defaults to `table.findByIdPrimary`; a resource whose `lookup` joins extra
   *  columns (e.g. listings' counts) must pass a primary-pinned equivalent so the
   *  write response still carries those columns. */
  lookupAfterWrite?: (id: number) => Promise<FullRow | null>;
  /** Resource name (lowercase plural, used in routes and log messages) */
  name: string;
  /** Field on Row that holds the display name (for delete confirmation) */
  nameField: keyof FullRow & string;
  /** Custom delete logic (e.g. cascade). If not provided, uses table.deleteById */
  onDelete?: (id: InValue) => Promise<void>;
  /** Auth policy for all generated routes. Defaults to ADMIN_API (any admin);
   *  pass OWNER_API for resources whose web management is owner-only. */
  policy?: AuthPolicy<"json">;
  /** Read only the pre-update fields needed by transactional hooks. */
  readState?: TransactionStateReader<State> | undefined;
  /** An atomic body-only side effect run around the row write. `Prepared` is
   *  the value its `validate` carries forward to its `persist`, inferred per
   *  resource. */
  sideEffect?: CrudSideEffect<Input, FullRow, Prepared, State>;
  /** Singular display name for activity log (e.g. "Holiday") */
  singular: string;
  /** Keys to strip from response (e.g. "slug_index") */
  stripKeys?: string[];
  /** Table with CRUD operations */
  table: Table<Row, Input>;
  /** Convert JSON body to Input for create */
  toCreateInput: (
    body: Record<string, unknown>,
  ) => Result<Input> | Promise<Result<Input>>;
  /** Convert JSON body + existing row to Input for update */
  toUpdateInput: (
    body: Record<string, unknown>,
    existing: FullRow,
  ) => Result<Input> | Promise<Result<Input>>;
  /** Optional validation (return error message or null) */
  validate?: (input: Input, id?: number) => Promise<string | null>;
  /** Optional delete guard: a returned message blocks the deletion with a 400
   *  (e.g. a sold hidden package whose tickets still resolve through it). */
  validateDelete?: (id: number) => Promise<string | null>;
}
