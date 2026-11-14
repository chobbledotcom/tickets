/** The shared types the admin record write path and the JSON door read. */

import type * as v from "valibot";
import type { TxScope } from "#db/client.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import type {
  AdminApiChild,
  AdminApiCustomRoute,
  AdminApiResource,
} from "#shared/admin-api-resources.ts";
import type { Result } from "#shared/result.ts";
import type { AdminSession } from "#types";

/** Extra response fields a record's batched hydration adds, keyed by row id. */
export type HydratedRows = ReadonlyMap<number, Record<string, unknown>>;

/** One side-effect's write-time validation: the post-save `input` (the row
 *  fields after the write), the raw `body`, and the `existing` full row on
 *  update (null on create). Returns `{ error }` to reject the whole write, or
 *  `{ value }` with the prepared data to persist once the row exists. */
export type CrudSideEffectValidate<Input, FullRow, Prepared> = (
  input: Input,
  body: Record<string, unknown>,
  existing: FullRow | null,
) => Promise<PreparedResult<Prepared>>;

/** One write step that runs inside the row's transaction. */
export type PersistStep<Prepared, State> = (
  tx: TxScope,
  id: number,
  value: Prepared,
  state: State | null,
) => Promise<void>;

/** One validation step's answer: the prepared value, or the refusal text. */
export type PreparedResult<Prepared> = { error: string } | { value: Prepared };

/** An atomic body-only side effect (for example relationship edges) for a
 *  create or update: `validate` runs before the write and either rejects or
 *  yields a prepared value, and `persist` runs in the row's transaction. */
export interface CrudSideEffect<Input, FullRow, Prepared, State = never> {
  persist: PersistStep<Prepared, State>;
  validate: CrudSideEffectValidate<Input, FullRow, Prepared>;
}

/** A post-commit hook keyed on the written row's id, for reconciling a derived
 *  table the transactional statement path would otherwise bypass. */
export interface AfterCommitConfig {
  afterCommit?: (id: number) => Promise<void>;
}

/** A guard run inside the row write's transaction, before the row statement.
 *  A returned message refuses the write and rolls it back. */
export type CheckTxHook<Input> = (
  tx: TxScope,
  id: number,
  input: Input,
) => Promise<string | null>;

/** The body a record's declared schema validates. A record without a declared
 *  schema keeps the server's own parser and the raw body. */
export type WriteBody<Schema> = Schema extends v.GenericSchema
  ? v.InferOutput<Schema>
  : Record<string, unknown>;

/** One write mapper: the validated body and the stored row in, the table input
 *  out. `session` rides along so a field-level gate can refuse per actor. */
export type WriteMapper<Input, Body, Existing> = (
  body: Body,
  existing: Existing,
  session?: AdminSession,
) => Result<Input> | Promise<Result<Input>>;

/** The handlers a record supplies for one declared child surface. Every
 *  declared verb is required: a child without all three is a compile error. */
export interface CrudChildHandlers {
  create: RouteHandlerFn;
  delete: RouteHandlerFn;
  update: RouteHandlerFn;
}

/** The handler records a record's JSON config must carry: one entry per child
 *  surface the resource table declares, and one per custom route. */
export type CrudApiHandlers<Entry extends AdminApiResource> =
  (Entry["children"] extends Record<string, AdminApiChild>
    ? {
        childHandlers: {
          [K in keyof NonNullable<Entry["children"]> &
            string]: CrudChildHandlers;
        };
      }
    : { childHandlers?: never }) &
    (Entry["custom"] extends Record<string, AdminApiCustomRoute>
      ? {
          customHandlers: {
            [K in keyof NonNullable<Entry["custom"]> & string]: RouteHandlerFn;
          };
        }
      : { customHandlers?: never });
