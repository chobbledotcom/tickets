import type { Client, Config, InArgs, ResultSet, Value } from "@libsql/client";
import * as v from "valibot";
import { createDatabaseClient } from "#db/database-client.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

const ValueSchema = v.variant("type", [
  v.object({ type: v.literal("null") }),
  v.object({ type: v.literal("integer"), value: v.string() }),
  v.object({ type: v.literal("float"), value: v.number() }),
  v.object({ type: v.literal("text"), value: v.string() }),
  v.object({ base64: v.string(), type: v.literal("blob") }),
]);
type WireValue = v.InferOutput<typeof ValueSchema>;

const decodeValue = (value: WireValue): Value => {
  if (value.type === "null") return null;
  if (value.type === "blob")
    return Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0))
      .buffer;
  if (value.type === "integer") return BigInt(value.value);
  return value.value;
};

const encodeValue = (value: Value): WireValue => {
  if (value === null) return { type: "null" };
  if (value instanceof ArrayBuffer)
    return {
      base64: btoa(String.fromCharCode(...new Uint8Array(value))),
      type: "blob",
    };
  if (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isInteger(value))
  ) {
    return { type: "integer", value: String(value) };
  }
  return typeof value === "number"
    ? { type: "float", value }
    : { type: "text", value };
};

const StatementSchema = v.object({
  args: v.optional(v.array(ValueSchema), []),
  named_args: v.optional(
    v.array(v.object({ name: v.string(), value: ValueSchema })),
    [],
  ),
  sql: v.optional(v.string()),
  sql_id: v.optional(v.number()),
  want_rows: v.optional(v.boolean()),
});
type Statement = v.InferOutput<typeof StatementSchema>;
type Condition = { type: string; step?: number; cond?: Condition };
const OperationSchema = v.object({
  batch: v.optional(
    v.object({
      steps: v.array(
        v.object({
          condition: v.optional(
            v.custom<Condition>((value) => typeof value === "object"),
          ),
          stmt: StatementSchema,
        }),
      ),
    }),
  ),
  sql: v.optional(v.string()),
  sql_id: v.optional(v.number()),
  stmt: v.optional(StatementSchema),
  type: v.string(),
});
const EnvelopeSchema = v.object({
  baton: v.optional(v.nullable(v.string())),
  requests: v.array(OperationSchema),
});
type Select = (
  sql: string,
  args: InArgs,
  primary: boolean,
) => Promise<ResultSet>;
type Fault = "begin" | "select" | "commit";
interface Reply {
  base_url: null;
  baton: null;
  results: unknown[];
}
interface TestFetch {
  envelopes: v.InferOutput<typeof EnvelopeSchema>[];
  fetch: (request: Request) => Promise<Response>;
  requests: string[][];
}

export const hranaBatchReply = (
  stepResults: unknown[],
  stepErrors: unknown[],
): unknown => ({
  response: {
    result: { step_errors: stepErrors, step_results: stepResults },
    type: "batch",
  },
  type: "ok",
});

export const hranaChangedReply =
  (change: (body: Reply) => void): ((body: Reply) => Response) =>
  (body) => {
    change(body);
    return Response.json(body);
  };

const wireResult = (result: ResultSet) => ({
  affected_row_count: result.rowsAffected,
  cols: result.columns.map((name, index) => ({
    decltype: result.columnTypes[index],
    name,
  })),
  last_insert_rowid: result.lastInsertRowid?.toString() ?? null,
  rows: result.rows.map((row) =>
    result.columns.map((name) => encodeValue(row[name]!)),
  ),
});

const statementArgs = (statement: Statement): InArgs =>
  statement.named_args.length === 0
    ? statement.args.map(decodeValue)
    : Object.fromEntries(
        statement.named_args.map(({ name, value }) => [
          name,
          decodeValue(value),
        ]),
      );

const statementStage = (sql: string): Fault => {
  if (sql.startsWith("BEGIN")) return "begin";
  return sql === "COMMIT" ? "commit" : "select";
};

const testExecution = (
  select: Select,
  fault: Fault | undefined,
  stored: Map<number, string>,
  operations: string[],
) => {
  let primary = false;
  return async (statement: Statement, separate: boolean) => {
    const sql = statement.sql ?? stored.get(statement.sql_id!);
    if (sql === undefined)
      throw new Error("The test received an unknown SQL id");
    if (separate) operations.push(sql);
    const stage = statementStage(sql);
    if (fault === stage && sql !== "ROLLBACK")
      throw new Error(`forced ${stage} failure`);
    if (stage === "begin") primary = separate;
    return wireResult(
      /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)
        ? emptyResultSet()
        : await select(sql, statementArgs(statement), primary),
    );
  };
};

const testBatch = async (
  operation: v.InferOutput<typeof OperationSchema>,
  execute: ReturnType<typeof testExecution>,
) => {
  const steps = operation.batch!.steps;
  const stepResults: unknown[] = steps.map(() => null);
  const stepErrors: unknown[] = steps.map(() => null);
  const matches = (condition: Condition): boolean => {
    if (condition.type === "not") return !matches(condition.cond!);
    return condition.type === "ok"
      ? stepResults[condition.step!] !== null
      : stepErrors[condition.step!] !== null;
  };
  for (const [index, step] of steps.entries()) {
    if (step.condition && !matches(step.condition)) continue;
    try {
      stepResults[index] = await execute(step.stmt, false);
    } catch (error) {
      stepErrors[index] = { code: "SQLITE_ERROR", message: String(error) };
    }
  }
  return { step_errors: stepErrors, step_results: stepResults };
};

const testOperation = async (
  operation: v.InferOutput<typeof OperationSchema>,
  execute: ReturnType<typeof testExecution>,
  stored: Map<number, string>,
  operations: string[],
) => {
  try {
    if (operation.type === "execute") {
      return {
        response: {
          result: await execute(operation.stmt!, true),
          type: "execute",
        },
        type: "ok",
      };
    }
    operations.push(operation.type);
    if (operation.type === "store_sql")
      stored.set(operation.sql_id!, operation.sql!);
    const response =
      operation.type === "batch"
        ? { result: await testBatch(operation, execute), type: "batch" }
        : { type: operation.type };
    return { response, type: "ok" };
  } catch (error) {
    return {
      error: { code: "SQLITE_ERROR", message: String(error) },
      type: "error",
    };
  }
};

export const hranaTestFetch = (
  select: Select = () => Promise.resolve(emptyResultSet()),
  fault?: Fault,
  reply: (body: Reply) => Response = Response.json,
): TestFetch => {
  const requests: string[][] = [];
  const envelopes: TestFetch["envelopes"] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const stored = new Map<number, string>();
    const envelope = v.parse(EnvelopeSchema, JSON.parse(await request.text()));
    envelopes.push(envelope);
    const operations: string[] = [];
    requests.push(operations);
    const execute = testExecution(select, fault, stored, operations);
    const results = [];
    for (const operation of envelope.requests) {
      results.push(await testOperation(operation, execute, stored, operations));
    }
    return reply({ base_url: null, baton: null, results });
  };
  return { envelopes, fetch, requests };
};

interface TestDatabase extends TestFetch, Disposable {
  client: Client;
}

export const hranaTestDatabase = (
  options: {
    select?: Select;
    fault?: Fault;
    reply?: (body: Reply) => Response;
    config?: Partial<Config>;
  } = {},
): TestDatabase => {
  const remote = hranaTestFetch(options.select, options.fault, options.reply);
  const client = createDatabaseClient({
    fetch: remote.fetch,
    url: "libsql://pipeline.test",
    ...options.config,
  });
  return { ...remote, client, [Symbol.dispose]: () => client.close() };
};

export const hranaTestSqlite = (
  intMode: Config["intMode"] = "number",
): TestDatabase & { local: Client } => {
  const local = hranaTestDatabase({
    config: { intMode: "bigint", url: "file::memory:" },
  });
  const remote = hranaTestDatabase({
    config: { intMode },
    select: (sql, args) => local.client.execute({ args, sql }),
  });
  return {
    ...remote,
    local: local.client,
    [Symbol.dispose]: () => {
      remote[Symbol.dispose]();
      local[Symbol.dispose]();
    },
  };
};
