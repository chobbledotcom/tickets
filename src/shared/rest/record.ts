/**
 * One admin record, declared once. This module turns the declaration in
 * `record-contract.ts` into the write commands both doors call.
 *
 * A record module imports no template and no route module, so the JSON API
 * bundle never loads a page.
 */

import { logActivity } from "#db/activity-log.ts";
import type { SqlStatement, TxScope } from "#db/client.ts";
import type { Table } from "#db/table.ts";
import { byPrimaryKey } from "#db/table-reader.ts";
import { refusingTheWriteOn } from "#db/transaction.ts";
import {
  type AdminRecord,
  type AnswersOf,
  type DeleteCommand,
  type DeleteRefusal,
  type DeleteVerdict,
  type FullRowOf,
  type InputOf,
  type RecordActor,
  type RecordShape,
  type RecordSpec,
  type RecordWrites,
  type RowOf,
  recordSurfaceOf,
  type StateOf,
  type WritePlan,
  type WriteVerdict,
} from "#shared/rest/record-contract.ts";
import {
  type JoinWrite,
  refusingCheckTx,
  writeEntity,
} from "#shared/rest/write-entity.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";
import { okResult } from "#shared/result.ts";

export * from "#shared/rest/record-contract.ts";

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

/** The activity line for one named row change. */
export const logNameActivity =
  (activityName: string) =>
  (name: string, verb: string, transaction?: TxScope): Promise<unknown> =>
    logActivity(
      `${activityName} '${name}' ${verb}`,
      undefined,
      undefined,
      transaction,
    );

/** Map one row write to the verdict both doors answer. The optional log runs
 * only for a written row. */
export const answerWrite = async <Row>(
  write: () => Promise<Row | null>,
  log?: (row: Row) => Promise<unknown>,
): Promise<WriteVerdict<Row>> => {
  try {
    const row = await write();
    if (row === null) return { kind: "not-found" };
    await log?.(row);
    return { kind: "written", row };
  } catch (error) {
    return {
      kind: "refused",
      message: transactionValidationMessageOrRethrow(error),
    };
  }
};

/** The declaration `defineRecord` reads. Its domain write and its delete
 * refusal keep their declared types, so the record's answers follow them. */
type DeclaredSpec<
  Shape extends RecordShape,
  Create,
  Update,
  Remove,
  Refusal,
> = Omit<RecordSpec<Shape>, "deleteRefusal" | "write"> & {
  readonly deleteRefusal?: Refusal;
  readonly write?: RecordWrites<
    InputOf<Shape>,
    FullRowOf<Shape>,
    Create & WriteVerdict<FullRowOf<Shape>>,
    Update & WriteVerdict<FullRowOf<Shape>>,
    Remove & DeleteVerdict
  >;
};

/**
 * A function that defines one record of a known shape. Each answer type
 * reads as `never` when the declaration names none. `Filled` names the facts
 * the definer supplies itself.
 */
export type RecordDefiner<
  Shape extends RecordShape,
  Filled extends keyof RecordSpec<Shape> = never,
> = <
  Create extends WriteVerdict<FullRowOf<Shape>> = never,
  Update extends WriteVerdict<FullRowOf<Shape>> = never,
  Remove extends DeleteVerdict = never,
  Refusal extends DeleteRefusal = never,
>(
  spec: Omit<DeclaredSpec<Shape, Create, Update, Remove, Refusal>, Filled>,
) => AdminRecord<
  Shape,
  AnswersOf<FullRowOf<Shape>, Create, Update, Remove, Refusal>
>;

/** The input of a record with no domain rule passes unchanged. */
const acceptInput = <Input>(input: Input) => okResult(input);

/**
 * Define one admin record. The returned object carries the single write path
 * both doors call. The first call names the record's shape. The second call
 * reads the declaration, so each command's answer type follows from it.
 */
export const defineRecord = <
  Shape extends RecordShape,
>(): RecordDefiner<Shape> => buildRecord<Shape> as RecordDefiner<Shape>;

/** Build the commands of one record. The answer types are wide here.
 * `defineRecord` narrows them from the declaration: a domain write answers
 * what its commands answer, and a table delete refuses only through
 * `deleteRefusal`, which `removeRow` reads. */
const buildRecord = <Shape extends RecordShape>(
  spec: RecordSpec<Shape>,
): AdminRecord<Shape> => {
  type Row = RowOf<Shape>;
  type Input = InputOf<Shape>;
  type FullRow = FullRowOf<Shape>;
  type State = StateOf<Shape>;
  const surface = recordSurfaceOf(spec.surface);
  const rule = spec.rule ?? acceptInput;
  const getAll =
    spec.getAll ??
    spec.reads?.all ??
    (() => {
      throw new Error(
        `The record for ${surface.list} declares no collection read`,
      );
    });
  const load =
    spec.load ??
    spec.reads?.one ??
    (spec.table === undefined
      ? () => {
          throw new Error(
            `The record for ${surface.list} declares no load read`,
          );
        }
      : defaultLoad(false)<Row, Input, FullRow>(spec.table));
  const loadAfterWrite =
    spec.loadAfterWrite ??
    spec.reads?.onePrimary ??
    (spec.table === undefined
      ? load
      : defaultLoad(true)<Row, Input, FullRow>(spec.table));
  const storedValues = (row: FullRow): Row =>
    spec.storedValues ? spec.storedValues(row) : row;

  /** The table a generated write needs. A command record can omit it. */
  const requireTable = (): Table<Row, Input> => {
    if (spec.table === undefined) {
      throw new Error(`The record for ${surface.list} declares no table`);
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
  const logWrite =
    (value: Input, verb: string) => async (tx: TxScope, id: number) => {
      await logActivity(
        `${spec.activityName} '${spec.logName(value)}' ${verb}`,
        spec.linkActivityToRow ? { id } : undefined,
        undefined,
        tx,
      );
    };

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
    if (!spec.logAfterCommit) writes.push(logWrite(value, verb));
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

  /** Run the one rule, prepare the plan, then write the row with its joins,
   * order, and log in one transaction. */
  const runWrite = async <Prepared>(
    input: Input,
    existing: FullRow | null,
    steps: WriteSteps<Row, Input, Prepared, State>,
  ): Promise<WriteVerdict<FullRow>> => {
    const ruled = await rule(
      input,
      existing === null ? null : storedValues(existing),
    );
    if (!ruled.ok) return { kind: "refused", message: ruled.error };
    const prepared = await preparePlan(steps.plan, ruled.value, existing);
    if ("error" in prepared) {
      return { kind: "refused", message: prepared.error };
    }
    const verdict = await answerWrite(() =>
      writeEntity<FullRow, State>({
        afterCommit: spec.afterCommit,
        buildStatement: () => Promise.resolve(steps.statementFor(ruled.value)),
        checkTx: steps.plan?.checkTx
          ? refusingTheWriteOn(steps.plan.checkTx)
          : refusingCheckTx(spec.checkTx, ruled.value),
        existingId: existing === null ? null : existing.id,
        joinWrites: joinWritesFor(
          ruled.value,
          steps.plan,
          prepared.value,
          steps.verb,
        ),
        plainWrite: () =>
          steps.plainWriteFor(ruled.value) as Promise<FullRow | null>,
        readBack: loadAfterWrite,
        readState: spec.readState,
        tableName: requireTable().name,
      }),
    );
    if (verdict.kind === "written" && spec.logAfterCommit) {
      await logActivity(
        `${spec.activityName} '${spec.logName(ruled.value)}' ${steps.verb}`,
        spec.linkActivityToRow ? { id: verdict.row.id } : undefined,
      );
    }
    return verdict;
  };

  type LoadedRow =
    | { kind: "not-found" }
    | { kind: "loaded"; row: FullRow; table: Table<Row, Input> };

  /** Read the row an update or delete works on. A table record reads the
   * primary, so a write sees its own row rather than a stale replica. */
  const loadForWrite = async (
    id: number,
    actor: RecordActor | undefined,
  ): Promise<LoadedRow> => {
    const row =
      spec.table !== undefined || spec.loadAfterWrite !== undefined
        ? await loadAfterWrite(id)
        : await load(id, actor);
    return row === null
      ? { kind: "not-found" }
      : { kind: "loaded", row, table: requireTable() };
  };

  /** Run one update or delete against the row it loaded, or answer not-found. */
  const withWriteRow = async <Answer>(
    id: number,
    actor: RecordActor | undefined,
    run: (row: FullRow, table: Table<Row, Input>) => Promise<Answer>,
  ): Promise<Answer | { kind: "not-found" }> => {
    const current = await loadForWrite(id, actor);
    return current.kind === "not-found"
      ? current
      : run(current.row, current.table);
  };

  const create: AdminRecord<Shape>["create"] = (input, plan) => {
    const table = requireTable();
    return runWrite(input, null, {
      plainWriteFor: (value) => table.insert(value),
      plan,
      statementFor: (value) => table.insertStatement!(value),
      verb: "created",
    });
  };

  const update: AdminRecord<Shape>["update"] = async (id, input, plan, actor) =>
    withWriteRow(id, actor, (existing, table) =>
      runWrite(input, existing, {
        plainWriteFor: (value) => table.update(id, value) as Promise<Row>,
        plan,
        statementFor: (value) => table.updateStatement!(id, value),
        verb: "updated",
      }),
    );

  /** Delete one loaded row: re-check it, run the refusal, delete, and log. */
  const removeRow = async (
    id: number,
    input: unknown,
    actor: RecordActor | undefined,
    existing: FullRow,
    table: Table<Row, Input>,
  ): Promise<DeleteVerdict> => {
    // The confirmation page loaded the row earlier. Re-check it here so a
    // row deleted between that page and this request answers not-found.
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

  const remove: DeleteCommand = async (id, input, actor) =>
    withWriteRow(id, actor, (existing, table) =>
      removeRow(id, input, actor, existing, table),
    );

  const write = spec.write;
  const commands: Pick<
    AdminRecord<Shape>,
    "create" | "remove" | "update"
  > = write === undefined
    ? { create, remove, update }
    : {
        create: (input, _plan, actor) => write.create(input, actor),
        remove: (id, input, actor) => write.remove(id, input, actor),
        update: (id, input, _plan, actor) => write.update(id, input, actor),
      };

  return {
    ...spec,
    ...surface,
    ...commands,
    getAll,
    load,
    loadAfterWrite,
    rule,
  };
};
