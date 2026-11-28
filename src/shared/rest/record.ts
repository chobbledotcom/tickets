/**
 * One admin record, declared once. This module turns the declaration in
 * `record-contract.ts` into the write commands both doors call.
 *
 * A record module imports no template and no route module, so the JSON API
 * bundle never loads a page.
 */

import { logActivity } from "#db/activity-log.ts";
import type { TxScope } from "#db/client.ts";

import { newRecordOf, recordsOf, rowValuesOf } from "#db/record-table.ts";
import type { TableHandle, TableWithId } from "#db/select/tables.ts";
import type { SqlStatement } from "#db/sql.ts";
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
  type RecordAnswers,
  type RecordShape,
  type RecordSpec,
  type RecordTableOf,
  type RecordWrites,
  type Refused,
  type RowOf,
  recordSurfaceOf,
  type StateOf,
  type UpdateCommand,
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
 * primary when a write must see its own row. The record's row holds every
 * column of the table, and a record that reads more declares its own load. */
const defaultLoad =
  (primary: boolean) =>
  <FullRow>(table: TableHandle<TableWithId>) =>
  async (id: number, _actor?: RecordActor): Promise<FullRow | null> =>
    (await (primary ? recordsOf(table).findPrimary : recordsOf(table).find)(
      id,
    )) as FullRow | null;

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
  NameField extends (keyof FullRowOf<Shape> & string) | undefined,
> = Omit<RecordSpec<Shape, NameField>, "deleteRefusal" | "write"> & {
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
  NameField extends
    | (keyof FullRowOf<Shape> & string)
    | undefined = "nameField" extends Filled
    ? keyof FullRowOf<Shape> & string
    : undefined,
>(
  spec: Omit<
    DeclaredSpec<Shape, Create, Update, Remove, Refusal, NameField>,
    Filled
  >,
) => RecordResult<
  Shape,
  AnswersOf<FullRowOf<Shape>, Create, Update, Remove, Refusal>,
  Filled,
  NameField
>;

/** The record a definer answers. A definer that fills the name field gives a
 *  concrete column, so the API can require it. */
type RecordResult<
  Shape extends RecordShape,
  Answers extends RecordAnswers<FullRowOf<Shape>>,
  Filled,
  NameField extends (keyof FullRowOf<Shape> & string) | undefined,
> = "nameField" extends Filled
  ? AdminRecord<Shape, Answers, keyof FullRowOf<Shape> & string>
  : AdminRecord<Shape, Answers, NameField>;

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
  type RecordTable = TableHandle<RecordTableOf<Shape>>;
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
      : defaultLoad(false)<FullRow>(spec.table));
  const loadAfterWrite =
    spec.loadAfterWrite ??
    spec.reads?.onePrimary ??
    (spec.table === undefined ? load : defaultLoad(true)<FullRow>(spec.table));
  const storedValues = (row: FullRow): Row =>
    spec.storedValues ? spec.storedValues(row) : row;

  /** The table a generated write needs. A command record can omit it. */
  const requireTable = (): RecordTable => {
    if (spec.table === undefined) {
      throw new Error(`The record for ${surface.list} declares no table`);
    }
    return spec.table;
  };

  /** The statement builder a generated write uses. */
  type StatementFor<Input> = (
    value: Input,
  ) => SqlStatement | Promise<SqlStatement>;

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
   * side effect, the record's join write, its order append, then its log. Only
   * a new row joins the end of its order, so an edit keeps its place. */
  const joinWritesFor = <Prepared>(
    value: Input,
    plan: WritePlan<Prepared, State> | undefined,
    prepared: Prepared,
    verb: string,
    creating: boolean,
  ): JoinWrite<State>[] => {
    const writes: JoinWrite<State>[] = [];
    if (plan?.persist) {
      writes.push((tx, id, state) => plan.persist!(tx, id, prepared, state));
    }
    if (spec.afterWrite) {
      writes.push((tx, id, state) => spec.afterWrite!(tx, id, value, state));
    }
    if (spec.order && creating) {
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
  type WriteSteps<Input, Prepared, State> = {
    plan: WritePlan<Prepared, State> | undefined;
    statementFor: StatementFor<Input>;
    verb: string;
  };

  /** Run the record's own input check, then the write command it guards. Both
   * write paths and both doors run this one check. Not async: a write that is
   * missing its table still throws where the caller can catch it. */
  const checked = <Answer>(
    input: Input,
    run: () => Promise<Answer>,
  ): Promise<Answer | Refused> => {
    const message = spec.inputCheck?.(input) ?? null;
    return message === null
      ? run()
      : Promise.resolve<Refused>({ kind: "refused", message });
  };

  /** Run the one rule, prepare the plan, then write the row with its joins,
   * order, and log in one transaction. */
  const runWrite = async <Prepared>(
    input: Input,
    existing: FullRow | null,
    steps: WriteSteps<Input, Prepared, State>,
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
          existing === null,
        ),
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
    | { kind: "loaded"; row: FullRow; table: RecordTable };

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
    run: (row: FullRow, table: RecordTable) => Promise<Answer>,
  ): Promise<Answer | { kind: "not-found" }> => {
    const current = await loadForWrite(id, actor);
    return current.kind === "not-found"
      ? current
      : run(current.row, current.table);
  };

  const create: AdminRecord<Shape>["create"] = (input, plan) => {
    const table = requireTable();
    return runWrite(input, null, {
      plan,
      statementFor: (value) =>
        recordsOf(table).insertStatement(
          newRecordOf(table, spec.fieldDefaults)(value as object),
        ),
      verb: "created",
    });
  };

  const update: AdminRecord<Shape>["update"] = async (id, input, plan, actor) =>
    withWriteRow(id, actor, (existing, table) =>
      runWrite(input, existing, {
        plan,
        statementFor: (value) =>
          recordsOf(table).updateStatement(
            id,
            rowValuesOf(table, value as object),
          ),
        verb: "updated",
      }),
    );

  /** Delete one loaded row: re-check it, run the refusal, delete, and log. */
  const removeRow = async (
    id: number,
    input: unknown,
    actor: RecordActor | undefined,
    existing: FullRow,
    table: RecordTable,
  ): Promise<DeleteVerdict> => {
    // The confirmation page loaded the row earlier. Re-check it here so a
    // row deleted between that page and this request answers not-found.
    if (!(await recordsOf(table).has(id))) {
      return { kind: "not-found" };
    }
    const refusal = spec.deleteRefusal
      ? await spec.deleteRefusal(id, actor)
      : null;
    if (refusal !== null) return { kind: "refused", message: refusal };
    if (spec.onDelete) {
      await spec.onDelete(id, input, actor);
    } else {
      await recordsOf(table).delete(id);
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
  /** The domain update, or the error of a record that declares none. */
  const updateOf = (
    declared: NonNullable<typeof spec.write>,
  ): UpdateCommand<Input, WriteVerdict<FullRow>> => {
    if (declared.update === undefined) {
      throw new Error(`The record for ${surface.list} declares no update`);
    }
    return declared.update;
  };
  const commands: Pick<
    AdminRecord<Shape>,
    "create" | "remove" | "update"
  > = write === undefined
    ? {
        create: (input, plan, actor) =>
          checked(input, () => create(input, plan, actor)),
        remove,
        update: (id, input, plan, actor) =>
          checked(input, () => update(id, input, plan, actor)),
      }
    : {
        create: (input, _plan, actor) =>
          checked(input, () => write.create(input, actor)),
        remove: (id, input, actor) => write.remove(id, input, actor),
        update: (id, input, _plan, actor) =>
          checked(input, () => updateOf(write)(id, input, actor)),
      };

  return {
    ...spec,
    ...surface,
    ...commands,
    getAll,
    load,
    loadAfterWrite,
    nameField: spec.nameField,
    rule,
  };
};
