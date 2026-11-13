/**
 * One admin record, declared once: its storage, its single write rule, its
 * lifecycle hooks, and the page route that declares its audience. The HTML
 * pages (`record-pages.ts`) and the JSON API (`record-api.ts`) both read this
 * declaration. Neither door carries a second copy of the write rule.
 *
 * A record module imports no template and no route module, so the JSON API
 * bundle never loads a page.
 */

import { logActivity } from "#db/activity-log.ts";
import type {
  SqlStatement,
  TransactionStateReader,
  TxScope,
} from "#db/client.ts";
import type { Table } from "#db/table.ts";
import { byPrimaryKey } from "#db/table-reader.ts";
import { refusingTheWriteOn } from "#db/transaction.ts";
import type { AuthSession } from "#routes/auth.ts";
import type { AdminApiResource } from "#shared/admin-api-resources.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestination, adminDestinationAt } from "#shared/admin-surface.ts";
import type {
  AfterCommitConfig,
  CheckTxHook,
} from "#shared/rest/crud-api-types.ts";
import {
  type JoinWrite,
  refusingCheckTx,
  writeEntity,
} from "#shared/rest/write-entity.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";
import type { Result } from "#shared/result.ts";
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
  ) => Promise<{ error: string } | { value: Prepared }>;
  persist?: (
    tx: TxScope,
    id: number,
    value: Prepared,
    state: State | null,
  ) => Promise<void>;
};

/** The one write rule. `input` is what the caller sent, already converted to
 * the record's input shape at the door. `stored` is the stored row on update
 * and null on create. The rule normalizes the input, or refuses it with the
 * text both doors answer. */
export type RecordRule<Input, Row> = (
  input: Input,
  stored: Row | null,
) => Result<Input> | Promise<Result<Input>>;

/** One ordered collection's create-time append. */
export type RecordOrder = {
  append: (args: { key: number; transaction: TxScope }) => Promise<void>;
};

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
  readonly getAll: (actor?: RecordActor) => Promise<ListRow[]>;
  /** Link create/update log entries to the row (the listing log does). */
  readonly linkActivityToRow?: boolean;
  /** The page route whose declaration gives the record its audience. */
  readonly list: AdminDestinationId;
  /** Read one row for a page, the API, and the delete confirmation. */
  readonly load?: (id: number, actor?: RecordActor) => Promise<FullRow | null>;
  /** Read a just-committed row back. Pinned to the primary by default. */
  readonly loadAfterWrite?: (id: number) => Promise<FullRow | null>;
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
    readonly create: (
      input: Input,
      actor?: RecordActor,
    ) => Promise<WriteVerdict<FullRow>>;
    readonly update: (
      id: number,
      input: Input,
      actor?: RecordActor,
    ) => Promise<WriteVerdict<FullRow>>;
    readonly remove: (
      id: number,
      input?: unknown,
      actor?: RecordActor,
    ) => Promise<DeleteVerdict>;
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
  readonly create: <Prepared = undefined>(
    input: Input,
    plan?: WritePlan<Prepared, State>,
    actor?: RecordActor,
  ) => Promise<WriteVerdict<FullRow>>;
  readonly load: (id: number, actor?: RecordActor) => Promise<FullRow | null>;
  readonly loadAfterWrite: (id: number) => Promise<FullRow | null>;
  readonly remove: (
    id: number,
    input?: unknown,
    actor?: RecordActor,
  ) => Promise<DeleteVerdict>;
  readonly update: <Prepared = undefined>(
    id: number,
    input: Input,
    plan?: WritePlan<Prepared, State>,
    actor?: RecordActor,
  ) => Promise<WriteVerdict<FullRow>>;
}

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

/** Read one row by its key, from the replica for a page read and from the
 * primary when a write must see its own row. */
const defaultLoad =
  (primary: boolean) =>
  <Row extends { id: number }, Input, FullRow extends Row>(
    table: Table<Row, Input>,
  ) =>
  (id: number, _actor?: RecordActor): Promise<FullRow | null> =>
    primary
      ? (table.findByIdPrimary!(id) as Promise<FullRow | null>)
      : (table.read.one(byPrimaryKey(table, id)) as Promise<FullRow | null>);

/**
 * Define one admin record. The returned object carries the single write path
 * both doors call.
 */
export const defineRecord = <
  Row extends { id: number },
  Input,
  FullRow extends Row = Row,
  State = never,
  ListRow = FullRow,
>(
  spec: RecordSpec<Row, Input, FullRow, State, ListRow>,
): AdminRecord<Row, Input, FullRow, State, ListRow> => {
  const load =
    spec.load ??
    (spec.table === undefined
      ? () => {
          throw new Error(`The record for ${spec.list} declares no load read`);
        }
      : defaultLoad(false)<Row, Input, FullRow>(spec.table));
  const loadAfterWrite =
    spec.loadAfterWrite ??
    (spec.table === undefined
      ? load
      : defaultLoad(true)<Row, Input, FullRow>(spec.table));
  const storedValues = (row: FullRow): Row =>
    spec.storedValues ? spec.storedValues(row) : row;

  /** The table a generated write needs. A command record can omit it. */
  const requireTable = (): Table<Row, Input> => {
    if (spec.table === undefined) {
      throw new Error(`The record for ${spec.list} declares no table`);
    }
    return spec.table;
  };

  /** The statement builder a generated write uses. */
  type StatementFor<Input> = (
    value: Input,
  ) => SqlStatement | Promise<SqlStatement>;

  /** The plain table write a generated write uses when it has no joins. */
  type PlainWriteFor<Row, Input> = (value: Input) => Promise<Row | null>;

  /** The activity line every write commits with the row. */
  const logWrite = (value: Input, verb: string) => (tx: TxScope, id: number) =>
    logActivity(
      `${spec.activityName} '${spec.logName(value)}' ${verb}`,
      spec.linkActivityToRow ? { id } : undefined,
      undefined,
      tx,
    ).then(() => undefined);

  /** The transaction steps a write runs after its row statement: the per-call
   * side effect, the record's join write, its order append, then its log. */
  const joinWritesFor = <Prepared>(
    value: Input,
    plan: WritePlan<Prepared, State> | undefined,
    prepared: Prepared,
    verb: string,
  ): JoinWrite<State>[] => {
    const writes: JoinWrite<State>[] = [];
    if (plan?.persist) {
      writes.push((tx, id, state) => plan.persist!(tx, id, prepared, state));
    }
    if (spec.afterWrite) {
      writes.push((tx, id, state) => spec.afterWrite!(tx, id, value, state));
    }
    if (spec.order) {
      writes.push((tx, id) => spec.order!.append({ key: id, transaction: tx }));
    }
    writes.push(logWrite(value, verb));
    return writes;
  };

  /** The plan's pre-write step: nothing to prepare when the caller declared no
   * side data. */
  const preparePlan = async <Prepared>(
    plan: WritePlan<Prepared, State> | undefined,
    value: Input,
    existing: FullRow | null,
  ): Promise<{ error: string } | { value: Prepared }> =>
    plan?.prepare
      ? plan.prepare(value, existing)
      : { value: undefined as Prepared };

  /** The statement builders, plan, and verb one generated write runs. */
  type WriteSteps<Row, Input, Prepared, State> = {
    plan: WritePlan<Prepared, State> | undefined;
    statementFor: StatementFor<Input>;
    plainWriteFor: PlainWriteFor<Row, Input>;
    verb: string;
  };

  /** Write the ruled row with every step above in one transaction, then read
   * it back from the primary. */
  const writeRuled = async <Prepared>(
    value: Input,
    prepared: Prepared,
    existing: FullRow | null,
    steps: WriteSteps<Row, Input, Prepared, State>,
  ): Promise<WriteVerdict<FullRow>> => {
    try {
      const row = await writeEntity<FullRow, State>({
        afterCommit: spec.afterCommit,
        buildStatement: () => Promise.resolve(steps.statementFor(value)),
        checkTx: steps.plan?.checkTx
          ? refusingTheWriteOn(steps.plan.checkTx)
          : refusingCheckTx(spec.checkTx, value),
        existingId: existing === null ? null : existing.id,
        joinWrites: joinWritesFor(value, steps.plan, prepared, steps.verb),
        plainWrite: () => steps.plainWriteFor(value) as Promise<FullRow | null>,
        readBack: loadAfterWrite,
        readState: spec.readState,
        tableName: requireTable().name,
      });
      return row === null ? { kind: "not-found" } : { kind: "written", row };
    } catch (error) {
      return {
        kind: "refused",
        message: transactionValidationMessageOrRethrow(error),
      };
    }
  };

  /** Run the one rule, prepare the plan, then write the row with its joins,
   * order, and log in one transaction. */
  const commitWrite = async <Prepared>(
    input: Input,
    existing: FullRow | null,
    steps: WriteSteps<Row, Input, Prepared, State>,
  ): Promise<WriteVerdict<FullRow>> => {
    const ruled = await spec.rule(
      input,
      existing === null ? null : storedValues(existing),
    );
    if (!ruled.ok) return { kind: "refused", message: ruled.error };
    const prepared = await preparePlan(steps.plan, ruled.value, existing);
    if ("error" in prepared) {
      return { kind: "refused", message: prepared.error };
    }
    return writeRuled(ruled.value, prepared.value, existing, steps);
  };

  const create = <Prepared = undefined>(
    input: Input,
    plan?: WritePlan<Prepared, State>,
    _actor?: RecordActor,
  ): Promise<WriteVerdict<FullRow>> => {
    const table = requireTable();
    return commitWrite(input, null, {
      plainWriteFor: (value) => table.insert(value),
      plan,
      statementFor: (value) => table.insertStatement!(value),
      verb: "created",
    });
  };

  const update = async <Prepared = undefined>(
    id: number,
    input: Input,
    plan?: WritePlan<Prepared, State>,
    actor?: RecordActor,
  ): Promise<WriteVerdict<FullRow>> => {
    const existing = await load(id, actor);
    if (existing === null) return { kind: "not-found" };
    const table = requireTable();
    return commitWrite(input, existing, {
      plainWriteFor: (value) => table.update(id, value) as Promise<Row>,
      plan,
      statementFor: (value) => table.updateStatement!(id, value),
      verb: "updated",
    });
  };

  const remove = async (
    id: number,
    input?: unknown,
    actor?: RecordActor,
  ): Promise<DeleteVerdict> => {
    const existing = await load(id, actor);
    if (existing === null) return { kind: "not-found" };
    const table = requireTable();
    // The confirmation page loaded the row earlier. Re-check it here so a row
    // deleted between that page and this request answers not-found.
    if (!(await table.read.exists(byPrimaryKey(table, id)))) {
      return { kind: "not-found" };
    }
    const refusal = spec.deleteRefusal
      ? await spec.deleteRefusal(id, actor)
      : null;
    if (refusal !== null) return { kind: "refused", message: refusal };
    if (spec.onDelete) {
      await spec.onDelete(id, input, actor);
    } else {
      await table.deleteById(id);
    }
    await logActivity(
      `${spec.activityName} '${spec.nameOf(existing)}' deleted`,
      spec.linkActivityToRow ? { id } : undefined,
    );
    return { kind: "deleted" };
  };

  return {
    ...spec,
    ...(spec.write
      ? {
          create: <Prepared = undefined>(
            input: Input,
            _plan?: WritePlan<Prepared, State>,
            actor?: RecordActor,
          ) => spec.write!.create(input, actor),
          remove: (id: number, input?: unknown, actor?: RecordActor) =>
            spec.write!.remove(id, input, actor),
          update: <Prepared = undefined>(
            id: number,
            input: Input,
            _plan?: WritePlan<Prepared, State>,
            actor?: RecordActor,
          ) => spec.write!.update(id, input, actor),
        }
      : { create, remove, update }),
    load,
    loadAfterWrite,
  };
};
