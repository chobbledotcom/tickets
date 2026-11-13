/** One command-record write step: run the domain write, refuse with its own
 *  message, or log the written row and answer it. */

import { type TxScope, withTransaction } from "#db/client.ts";
import type {
  DeleteCommand,
  DeleteVerdict,
  InputValidator,
  RecordRule,
  UpdateCommand,
  WriteCommand,
  WriteVerdict,
} from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** Wrap a validator that takes an optional row id as the record's one rule.
 *  The stored row supplies that id on update. */
export const ruleFromValidator =
  <Input, Row extends { id: number }>(
    validate: InputValidator<Input>,
  ): RecordRule<Input, Row> =>
  async (input, stored) => {
    const error = await validate(input, stored?.id);
    return error === null ? okResult(input) : errorResult(error);
  };

/** The words every command write shares: its refusal message, its missing-row
 *  error, and its activity line. */
type CommandWords<Error extends string, Log> = {
  /** The operator-facing message for one domain error. */
  message: (error: Error) => string;
  /** One error that means the row is not there, rather than a refusal. */
  notFound?: Error;
  /** The activity line the write commits with the row. */
  log: Log;
};

export type CommandWrite<Row, Error extends string = string> = CommandWords<
  Error,
  (row: Row) => Promise<unknown>
> & {
  /** The domain write: the saved row, or the error it refused with. */
  write: () => Promise<Result<Row, Error>>;
};

/** The optional absent-row error, spread into a command config. */
const notFoundField = <Error extends string>(notFound: Error | undefined) =>
  notFound === undefined ? {} : { notFound };

/** Run one command-record write and answer its verdict. */
export const writeAndLog = async <Row, Error extends string = string>(
  config: CommandWrite<Row, Error>,
): Promise<WriteVerdict<Row>> => {
  const saved = await config.write();
  if (!saved.ok) {
    return config.notFound === saved.error
      ? { kind: "not-found" as const }
      : { kind: "refused" as const, message: config.message(saved.error) };
  }
  await config.log(saved.value);
  return { kind: "written", row: saved.value };
};

/** Run the record's one rule, then a command that answers its own verdict. */
export const ruledCommand = async <Row, Input>(config: {
  input: Input;
  run: (value: Input) => Promise<WriteVerdict<Row>>;
  rule: RecordRule<Input, Row>;
  stored: Row | null;
}): Promise<WriteVerdict<Row>> => {
  const ruled = await config.rule(config.input, config.stored);
  return ruled.ok
    ? config.run(ruled.value)
    : { kind: "refused", message: ruled.error };
};

/** The facts one command write runs with. */
type CommandRun<Row, Input, Error extends string = string> = {
  input: Input;
  stored: Row | null;
  rule: RecordRule<Input, Row>;
  write: (value: Input) => Promise<Result<Row, Error>>;
  message: (error: Error) => string;
  notFound?: Error;
  log: (row: Row) => Promise<unknown>;
};

/** Run the record's one rule, then the command write. */
export const commitCommand = async <Row, Input, Error extends string = string>(
  config: CommandRun<Row, Input, Error>,
): Promise<WriteVerdict<Row>> =>
  ruledCommand({
    input: config.input,
    rule: config.rule,
    run: (value) =>
      writeAndLog({
        log: config.log,
        message: config.message,
        write: () => config.write(value),
        ...notFoundField(config.notFound),
      }),
    stored: config.stored,
  });

/** Run one command write inside a transaction, so its log line commits with
 *  the row it names. */
export const transactCommand = async <
  Row,
  Input,
  Error extends string = string,
>(
  config: Omit<CommandRun<Row, Input, Error>, "stored" | "write" | "log"> & {
    write: (tx: TxScope, value: Input) => Promise<Result<Row, Error>>;
    log: (row: Row, tx: TxScope) => Promise<unknown>;
  },
): Promise<WriteVerdict<Row>> =>
  withTransaction((tx) =>
    commitCommand<Row, Input, Error>({
      input: config.input,
      log: (row) => config.log(row, tx),
      message: config.message,
      rule: config.rule,
      stored: null,
      write: (value) => config.write(tx, value),
      ...notFoundField(config.notFound),
    }),
  );

/** Load one command record's row, then save it. A missing row answers
 * not-found. */
export const updateIfPresent = async <Row, Input>(
  load: (id: number) => Promise<Row | null>,
  save: (row: Row, input: Input) => Promise<WriteVerdict<Row>>,
  id: number,
  input: Input,
): Promise<WriteVerdict<Row>> => {
  const row = await load(id);
  return row === null ? { kind: "not-found" } : save(row, input);
};

/** The steps one record delete runs. */
type DeleteSteps<Row> = {
  load: (id: number) => Promise<Row | null>;
  destroy: (row: Row) => Promise<unknown>;
  log?: (row: Row) => Promise<unknown>;
};

/** Load one present row, delete it, and answer the verdict. */
export const deleteIfPresent = async <Row>(
  id: number,
  config: DeleteSteps<Row>,
): Promise<DeleteVerdict> => {
  const row = await config.load(id);
  if (row === null) return { kind: "not-found" };
  await config.destroy(row);
  if (config.log) await config.log(row);
  return { kind: "deleted" };
};

/** Load one command record's row, delete it, and log the deletion. */
export const deleteAndLog = <Row>(
  id: number,
  config: DeleteSteps<Row> & {
    log: (row: Row) => Promise<unknown>;
  },
): Promise<DeleteVerdict> => deleteIfPresent(id, config);

/** Build one record's delete command from its load, destroy, and log steps. */
export const deleteCommand =
  <Row>(
    load: (id: number) => Promise<Row | null>,
    destroy: (row: Row) => Promise<unknown>,
    log: (row: Row) => Promise<unknown>,
  ) =>
  (id: number): Promise<DeleteVerdict> =>
    deleteAndLog(id, { destroy, load, log });

/** The three writes of a content record with a slug: its domain create,
 *  update, and delete, and the words its slug error and activity line use. */
export const contentCommands = <
  Row extends { id: number; name: string },
  Input,
  Error extends string = string,
>(config: {
  load: (id: number) => Promise<Row | null>;
  create: (input: Input, tx: TxScope) => Promise<Result<Row, Error>>;
  update: (
    id: number,
    input: Input,
    tx: TxScope,
  ) => Promise<Result<Row, Error>>;
  remove: (row: Row) => Promise<unknown>;
  log: (name: string, verb: string, tx?: TxScope) => Promise<unknown>;
  message: () => string;
  notFound?: Error;
  rule: RecordRule<Input, Row>;
  /** An update carries the slug the create generated. */
  updateInput: (input: Input) => Input;
}): {
  create: WriteCommand<Input, Row>;
  update: UpdateCommand<Input, Row>;
  remove: DeleteCommand;
} => {
  const words = (verb: string) => ({
    log: (row: Row, tx: TxScope) => config.log(row.name, verb, tx),
    message: () => config.message(),
    rule: config.rule,
  });
  return {
    create: (input) =>
      transactCommand({
        ...words("created"),
        input,
        write: (tx, value) => config.create(value, tx),
      }),
    remove: deleteCommand(config.load, config.remove, (row) =>
      config.log(row.name, "deleted"),
    ),
    update: (id, input) =>
      updateIfPresent(
        config.load,
        () =>
          transactCommand<Row, Input, Error>({
            ...words("updated"),
            input: config.updateInput(input),
            ...(config.notFound === undefined
              ? {}
              : { notFound: config.notFound }),
            write: (tx, value) => config.update(id, value, tx),
          }),
        id,
        input,
      ),
  };
};
