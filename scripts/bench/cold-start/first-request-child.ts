/**
 * Child for the first-request benchmark: one freshly booted isolate against
 * the parent's prepared database, every statement paying a fake network
 * delay. Serves `GET /` twice (cold, warm) and prints timings + a per-query
 * timeline as one JSON line. Usage: first-request-child.ts <latencyMs>
 */

import {
  type Client,
  createClient,
  type InArgs,
  type InStatement,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { setDb } from "#shared/db/client.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { setSuppressRequestLogs } from "#shared/logger.ts";
import { delay } from "#shared/now.ts";
import {
  setBuildCommitForTest,
  setBuildTimestampForTest,
} from "#shared/update.ts";
import { serveHandler } from "#src/serve-app.ts";
import { timedRunner } from "../../timed-run.ts";
import { serveAndDrainRoot } from "./serve-root.ts";

// Keep stdout clean for the JSON result line the parent parses.
setSuppressDebugLogs(true);
setSuppressRequestLogs(true);

// Carry the parent's build markers: steady-state read-only boot path.
const benchBuildIso = Deno.env.get("BENCH_BUILD_ISO");
if (benchBuildIso) setBuildTimestampForTest(benchBuildIso);
const benchBuildCommit = Deno.env.get("BENCH_BUILD_COMMIT");
if (benchBuildCommit) setBuildCommitForTest(benchBuildCommit);

type QueryEvent = {
  ms: number;
  sql: string;
  startOffsetMs: number;
};

const latencyMs = Number(Deno.args[0] ?? 0);
const timeline: QueryEvent[] = [];
// Query offsets are measured from the start of the request being timed.
let requestStart = 0;

const pushEvent = (sql: string, start: number): void => {
  timeline.push({
    ms: performance.now() - start,
    sql: sql.replace(/\s+/g, " ").slice(0, 80),
    startOffsetMs: start - requestStart,
  });
};

/** Pay the fake latency, run the query, land it on the timeline. */
const record = timedRunner({
  after: (sql, startedAt) => pushEvent(sql, startedAt),
  before: () => delay(latencyMs),
});

const statementSql = (statement: InStatement): string =>
  typeof statement === "string" ? statement : statement.sql;

/** The `execute` override for a wrapped client or transaction — runs either
 * overload through the delay + timeline. */
const recordedExecute =
  (target: Pick<Client, "execute">) =>
  (statement: InStatement | string, args?: InArgs): Promise<ResultSet> =>
    record(
      statementSql(statement),
      (): Promise<ResultSet> =>
        typeof statement === "string" && args !== undefined
          ? target.execute(statement, args)
          : target.execute(statement as InStatement),
    );

/** Proxy `target`, overriding the given members; everything else forwards
 *  (methods bound so they keep working). */
const proxyMembers = <T extends object>(
  target: T,
  overrides: Record<string, unknown>,
): T =>
  new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) {
        return overrides[prop];
      }
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });

/** Wrap a transaction so each statement inside it also pays the delay. */
const wrapTransaction = (tx: Transaction): Transaction =>
  proxyMembers(tx, {
    commit: () => record("COMMIT", () => tx.commit()),
    execute: recordedExecute(tx),
  });

/** Wrap the client so every round trip pays the delay and lands on the timeline. */
const wrapClient = (client: Client): Client =>
  proxyMembers(client, {
    batch: (statements: InStatement[], mode?: TransactionMode) =>
      record(
        `batch[${statements.length}]: ${statements
          .map(statementSql)
          .join(" | ")}`,
        () => client.batch(statements, mode),
      ),
    execute: recordedExecute(client),
    transaction: async (mode?: TransactionMode) =>
      wrapTransaction(
        await record("BEGIN", () =>
          mode === undefined ? client.transaction() : client.transaction(mode),
        ),
      ),
  });

const dbUrl = Deno.env.get("DB_URL");
if (!dbUrl) throw new Error("DB_URL is required");
setDb(wrapClient(createClient({ url: dbUrl })));

const timedRequest = async (): Promise<{ ms: number; status: number }> => {
  requestStart = performance.now();
  const response = await serveAndDrainRoot(serveHandler);
  return { ms: performance.now() - requestStart, status: response.status };
};

const first = await timedRequest();
const firstTimeline = [...timeline];
timeline.length = 0;
const second = await timedRequest();

console.log(
  JSON.stringify({
    firstMs: first.ms,
    firstQueryCount: firstTimeline.length,
    firstStatus: first.status,
    firstTimeline,
    latencyMs,
    secondMs: second.ms,
    secondQueryCount: timeline.length,
    secondStatus: second.status,
    secondTimeline: timeline,
  }),
);
