/**
 * The one admin record contract: its storage, its single write rule, its
 * lifecycle hooks, its commands, and the page route that declares its
 * audience. The implementation is in `record.ts`.
 */

import type { TransactionStateReader, TxScope } from "#db/client.ts";
import type { OrderedCollection } from "#db/ordered-collection.ts";
import type { Table } from "#db/table.ts";
import type { AuthSession } from "#routes/auth.ts";
import type { AdminApiResource } from "#shared/admin-api-resources.ts";
import type {
  AdminDestinationId,
  RecordAreaId,
} from "#shared/admin-surface/ids.ts";
import {
  adminDestination,
  adminDestinationAt,
  recordAreaIds,
} from "#shared/admin-surface.ts";
import type {
  AfterCommitConfig,
  CheckTxHook,
  PersistStep,
  PreparedResult,
} from "#shared/rest/crud-api-types.ts";
import type { AsyncResult } from "#shared/result.ts";
import type { AdminLevel } from "#types";

/** The request actor a door hands a record whose read or write needs it. A
 * per-user row or a secret read uses the session at its boundary. */
export type RecordActor = { session: AuthSession };

/** The refusal answer a write or delete command gives. */
type RefusalVerdict =
  | { kind: "refused"; message: string }
  | { kind: "not-found" };

/** The answer to one write command. A refusal is a domain rule, and a page and
 * the JSON API answer it with the same text. */
export type WriteVerdict<Row> = { kind: "written"; row: Row } | RefusalVerdict;

/** The answer to one delete command. */
export type DeleteVerdict = { kind: "deleted" } | RefusalVerdict;

/** One read by key, for a page, the JSON API, and the delete confirmation. */
export type LoadCommand<FullRow> = (
  id: number,
  actor?: RecordActor,
) => Promise<FullRow | null>;

/** One read of the row a write just committed. */
export type LoadAfterWriteCommand<FullRow> = (
  id: number,
) => Promise<FullRow | null>;

/** One collection read. */
export type GetAllCommand<ListRow> = (
  actor?: RecordActor,
) => Promise<ListRow[]>;

/** A command that takes the record's arguments and the request actor. */
type ActorCommand<Args extends unknown[], Answer> = (
  ...args: [...Args, actor?: RecordActor]
) => Promise<Answer>;

/** A generated command that also takes the record's per-call plan. */
type PlannedCommand<Args extends unknown[], Answer, State> = <
  Prepared = undefined,
>(
  ...args: [...Args, plan?: WritePlan<Prepared, State>, actor?: RecordActor]
) => Promise<Answer>;

/** One domain create, before the record adds a per-call plan. */
export type WriteCommand<Input, FullRow> = ActorCommand<
  [input: Input],
  WriteVerdict<FullRow>
>;

/** One domain update, before the record adds a per-call plan. */
export type UpdateCommand<Input, FullRow> = ActorCommand<
  [id: number, input: Input],
  WriteVerdict<FullRow>
>;

/** One domain delete. */
export type DeleteCommand = ActorCommand<
  [id: number, input?: unknown],
  DeleteVerdict
>;

/** One generated create, with the record's per-call plan. */
export type PlannedWriteCommand<Input, FullRow, State> = PlannedCommand<
  [input: Input],
  WriteVerdict<FullRow>,
  State
>;

/** One generated update, with the record's per-call plan. */
export type PlannedUpdateCommand<Input, FullRow, State> = PlannedCommand<
  [id: number, input: Input],
  WriteVerdict<FullRow>,
  State
>;

/** A per-call extra step for a write that carries side data (the listing's
 * group and option edges). `prepare` runs before the row statement and can
 * refuse the whole write. `persist` runs in the row's transaction, before the
 * record's own `afterWrite`. */
export type WritePlan<Prepared, State = never> = {
  /** A guard for this call, run inside the transaction before the row
   * statement. Overrides the record's `checkTx` when present. */
  checkTx?: (tx: TxScope, id: number) => Promise<string | null>;
  prepare?: (
    input: unknown,
    existing: unknown,
  ) => Promise<PreparedResult<Prepared>>;
  persist?: PersistStep<Prepared, State>;
};

/** A validator that answers the message a value fails with, or null. */
export type InputValidator<Input> = (
  input: Input,
  id?: number,
) => Promise<string | null>;

/** The stored shapes one record declaration names. A record that omits a
 * read shape reads its write row. */
export type RecordShape = {
  row: { id: number };
  input: unknown;
  fullRow?: { id: number };
  listRow?: unknown;
  state?: unknown;
};

/** Build the shape of one record from its row, input, and optional read and
 * state shapes. */
export type RecordShapeOf<
  Row extends { id: number },
  Input,
  FullRow extends Row = Row,
  State = never,
  ListRow = FullRow,
> = {
  row: Row;
  input: Input;
  fullRow: FullRow;
  listRow: ListRow;
  state: State;
};

export type RowOf<Shape extends RecordShape> = Shape["row"];
export type InputOf<Shape extends RecordShape> = Shape["input"];
export type FullRowOf<Shape extends RecordShape> = Shape extends {
  fullRow: infer FullRow extends { id: number };
}
  ? FullRow
  : RowOf<Shape>;
export type ListRowOf<Shape extends RecordShape> = Shape extends {
  listRow: infer ListRow;
}
  ? ListRow
  : FullRowOf<Shape>;
export type StateOf<Shape extends RecordShape> = Shape extends {
  state: infer State;
}
  ? State
  : never;

/** The one write rule. `input` is what the caller sent, already converted to
 * the record's input shape at the door. `stored` is the stored row on update
 * and null on create. The rule normalizes the input, or refuses it with the
 * text both doors answer. */
export type RecordRule<Input, Row> = (
  input: Input,
  stored: Row | null,
) => AsyncResult<Input>;

/** One ordered collection's create-time append. */
export type RecordOrder = Pick<OrderedCollection<"id", undefined>, "append">;

/** The route facts a record serves its audience from. */
export type RecordSurface = {
  /** The delete page, when it differs from the collection path with
   * `/:id/delete`. */
  readonly deleteDestination?: AdminDestinationId;
  /** The record's own page. A record without one has no Edit tab. */
  readonly detail?: AdminDestinationId;
  /** The page route whose declaration gives the record its audience. */
  readonly list: AdminDestinationId;
};

/** The route facts of a record: the ids its area declares, or the ids a
 * record outside a record area names itself. */
export const recordSurfaceOf = (
  surface: RecordAreaId | RecordSurface,
): RecordSurface => {
  if (typeof surface !== "string") return surface;
  const ids = recordAreaIds(surface);
  return { deleteDestination: ids.remove, detail: ids.detail, list: ids.list };
};

/**
 * The declaration of one admin record.
 *
 * `Shape.row` is the stored row the table writes. `Shape.fullRow` is the row
 * the pages and the API read back. It differs from the write row only when a
 * read joins extra columns. `Shape.state` is the narrow pre-update state a
 * transactional hook needs.
 */
export interface RecordSpec<Shape extends RecordShape>
  extends AfterCommitConfig {
  /** The words the activity log uses for this record. */
  readonly activityName: string;
  /** A join write inside the row write's transaction. Runs before the order
   * append and the activity log. */
  readonly afterWrite?: (
    tx: TxScope,
    id: number,
    input: InputOf<Shape>,
    state: StateOf<Shape> | null,
  ) => Promise<void>;
  /** The admin API entry: its path, envelopes, and wire schemas. Absent for a
   * page-only record. */
  readonly api?: AdminApiResource;
  /** A guard inside the row write's transaction, before the row statement. */
  readonly checkTx?: CheckTxHook<InputOf<Shape>>;
  /** A refusal the JSON delete answers beyond the confirmation check. The
   * page can declare its own pre-render guard. */
  readonly deleteRefusal?: (
    id: number,
    actor?: RecordActor,
  ) => Promise<string | null>;
  readonly getAll?: GetAllCommand<ListRowOf<Shape>>;
  /** Link create/update log entries to the row (the listing log does). */
  readonly linkActivityToRow?: boolean;
  /** Read one row for a page, the API, and the delete confirmation. */
  readonly load?: LoadCommand<FullRowOf<Shape>>;
  /** Read a just-committed row back. Pinned to the primary by default. */
  readonly loadAfterWrite?: LoadAfterWriteCommand<FullRowOf<Shape>>;
  /** Log after the row transaction commits. A failed log must not undo a
   * committed listing. */
  readonly logAfterCommit?: boolean;
  /** The display name to log, taken from the input the write just made. An
   * update input carries the values the row now holds. */
  readonly logName: (input: InputOf<Shape>) => string;
  /** The display-name column, for the JSON delete confirmation. */
  readonly nameField?: keyof FullRowOf<Shape> & string;
  /** The message key of the name a delete confirmation page asks for. */
  readonly nameLabel?: string;
  /** The row's display name: the delete confirmation and the activity log. */
  readonly nameOf: (row: RowOf<Shape>) => string;
  /** The delete itself. Defaults to deleting the table row. */
  readonly onDelete?: (
    id: number,
    input: unknown,
    actor?: RecordActor,
  ) => Promise<void>;
  /** The create-time order append. Inside the row write's transaction, so a
   * row never exists unplaced. */
  readonly order?: RecordOrder;
  /** Read the narrow pre-update state `afterWrite` and `checkTx` need. */
  readonly readState?: TransactionStateReader<StateOf<Shape>>;
  /** The three reads the record serves, when its db module exports them
   *  together. A record can name one read directly instead. */
  readonly reads?: {
    readonly all: GetAllCommand<ListRowOf<Shape>>;
    readonly one?: LoadCommand<FullRowOf<Shape>>;
    readonly onePrimary?: LoadAfterWriteCommand<FullRowOf<Shape>>;
  };
  /** The one write rule. Both doors run it before any write. */
  readonly rule: RecordRule<InputOf<Shape>, RowOf<Shape>>;
  /** The record page a save lands on, when it differs from the collection's
   * declared `afterSave`. */
  readonly saveLanding?: AdminDestinationId;
  /** What the write rule sees as the stored row. Defaults to the read row. */
  readonly storedValues?: (row: FullRowOf<Shape>) => RowOf<Shape>;
  /** Where the record lives: the record area that declares its routes and
   * its audience, or the route ids of a record outside a record area. */
  readonly surface: RecordAreaId | RecordSurface;
  readonly table?: Table<RowOf<Shape>, InputOf<Shape>>;
  /** A record whose writes go through a domain boundary rather than its table
   * statement gives its three commands here. Each command applies `rule`
   * itself, so the one rule still holds at both doors. */
  readonly write?: {
    readonly create: WriteCommand<InputOf<Shape>, FullRowOf<Shape>>;
    readonly update: UpdateCommand<InputOf<Shape>, FullRowOf<Shape>>;
    readonly remove: DeleteCommand;
  };
}

/** One admin record, with its write commands. */
export interface AdminRecord<Shape extends RecordShape>
  extends RecordSpec<Shape>,
    RecordSurface {
  readonly create: PlannedWriteCommand<
    InputOf<Shape>,
    FullRowOf<Shape>,
    StateOf<Shape>
  >;
  readonly getAll: GetAllCommand<ListRowOf<Shape>>;
  readonly load: LoadCommand<FullRowOf<Shape>>;
  readonly loadAfterWrite: LoadAfterWriteCommand<FullRowOf<Shape>>;
  readonly remove: DeleteCommand;
  readonly update: PlannedUpdateCommand<
    InputOf<Shape>,
    FullRowOf<Shape>,
    StateOf<Shape>
  >;
}

/** The JSON audience the page route for one destination declares. The surface
 * table is the only place a role is written down, so neither door can name a
 * policy of its own. */
export const jsonAudienceFor = (
  id: AdminDestinationId,
): readonly AdminLevel[] => adminDestination(id).audience;

/** The delete page's destination: the declared override, else the collection
 * path with `/:id/delete`. */
const deleteDestinationFor = (spec: RecordSurface): AdminDestinationId => {
  if (spec.deleteDestination) return spec.deleteDestination;
  return adminDestinationAt(`${adminDestination(spec.list).pattern}/:id/delete`)
    .id as AdminDestinationId;
};

/** The delete route's audience, for the JSON delete policy. */
export const deleteAudienceFor = (spec: RecordSurface): readonly AdminLevel[] =>
  jsonAudienceFor(deleteDestinationFor(spec));

/** The record page and the delete page of a record that a record area
 * declares. A record outside a record area has no such page. */
export const recordPageIds = (
  record: RecordSurface,
): {
  deleteDestination: AdminDestinationId;
  destination: AdminDestinationId;
} => {
  if (record.detail === undefined || record.deleteDestination === undefined) {
    throw new Error(`The record for ${record.list} declares no record page`);
  }
  return {
    deleteDestination: record.deleteDestination,
    destination: record.detail,
  };
};
