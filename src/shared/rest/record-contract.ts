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
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestination, adminDestinationAt } from "#shared/admin-surface.ts";
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

/* jscpd:ignore-start -- TypeScript repeats the type parameters on every generic declaration */
/**
 * The declaration of one admin record.
 *
 * `Row` is the stored row the table writes. `FullRow` is the row the pages and
 * the API read back. It differs from `Row` only when a read joins extra
 * columns. `State` is the narrow pre-update state a transactional hook needs.
 */
export interface RecordSpec<
  Row extends { id: number },
  Input,
  FullRow extends Row = Row,
  State = never,
  ListRow = FullRow,
> extends AfterCommitConfig {
  /** The words the activity log uses for this record. */
  readonly activityName: string;
  /** A join write inside the row write's transaction. Runs before the order
   * append and the activity log. */
  readonly afterWrite?: (
    tx: TxScope,
    id: number,
    input: Input,
    state: State | null,
  ) => Promise<void>;
  /** The admin API entry: its path, envelopes, and wire schemas. Absent for a
   * page-only record. */
  readonly api?: AdminApiResource;
  /** A guard inside the row write's transaction, before the row statement. */
  readonly checkTx?: CheckTxHook<Input>;
  /** The delete page's destination, when it differs from the collection's
   * route (the group delete page is staff-only while its list admits
   * editors). Defaults to the collection path with `/:id/delete`. */
  readonly deleteDestination?: AdminDestinationId;
  /** A refusal the JSON delete answers beyond the confirmation check. The
   * page can declare its own pre-render guard. */
  readonly deleteRefusal?: (
    id: number,
    actor?: RecordActor,
  ) => Promise<string | null>;
  readonly getAll: GetAllCommand<ListRow>;
  /** Link create/update log entries to the row (the listing log does). */
  readonly linkActivityToRow?: boolean;
  /** The page route whose declaration gives the record its audience. */
  readonly list: AdminDestinationId;
  /** Read one row for a page, the API, and the delete confirmation. */
  readonly load?: LoadCommand<FullRow>;
  /** Read a just-committed row back. Pinned to the primary by default. */
  readonly loadAfterWrite?: LoadAfterWriteCommand<FullRow>;
  /** Log after the row transaction commits. A failed log must not undo a
   * committed listing. */
  readonly logAfterCommit?: boolean;
  /** The display name to log, taken from the input the write just made. An
   * update input carries the values the row now holds. */
  readonly logName: (input: Input) => string;
  /** The display-name column, for the JSON delete confirmation. */
  readonly nameField?: keyof FullRow & string;
  /** The row's display name: the delete confirmation and the activity log. */
  readonly nameOf: (row: Row) => string;
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
  readonly readState?: TransactionStateReader<State>;
  /** The one write rule. Both doors run it before any write. */
  readonly rule: RecordRule<Input, Row>;
  /** The record page a save lands on, when it differs from the collection's
   * declared `afterSave`. */
  readonly saveLanding?: AdminDestinationId;
  /** What the write rule sees as the stored row. Defaults to the read row. */
  readonly storedValues?: (row: FullRow) => Row;
  readonly table?: Table<Row, Input>;
  /** A record whose writes go through a domain boundary rather than its table
   * statement gives its three commands here. Each command applies `rule`
   * itself, so the one rule still holds at both doors. */
  readonly write?: {
    readonly create: WriteCommand<Input, FullRow>;
    readonly update: UpdateCommand<Input, FullRow>;
    readonly remove: DeleteCommand;
  };
}

/** One admin record, with its write commands. */
export interface AdminRecord<
  Row extends { id: number },
  Input,
  FullRow extends Row = Row,
  State = never,
  ListRow = FullRow,
> extends RecordSpec<Row, Input, FullRow, State, ListRow> {
  readonly create: PlannedWriteCommand<Input, FullRow, State>;
  readonly load: LoadCommand<FullRow>;
  readonly loadAfterWrite: LoadAfterWriteCommand<FullRow>;
  readonly remove: DeleteCommand;
  readonly update: PlannedUpdateCommand<Input, FullRow, State>;
}
/* jscpd:ignore-end */

/** The JSON audience the page route for one destination declares. The surface
 * table is the only place a role is written down, so neither door can name a
 * policy of its own. */
export const jsonAudienceFor = (
  id: AdminDestinationId,
): readonly AdminLevel[] => adminDestination(id).audience;

/** The route facts a record declares for its audience. */
export type RecordSurface = {
  readonly deleteDestination?: AdminDestinationId;
  readonly list: AdminDestinationId;
};

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
