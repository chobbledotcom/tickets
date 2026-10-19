/**
 * Child for the first-request benchmark: one freshly booted isolate against
 * the parent's prepared database, every statement paying a fake network
 * delay. Serves the parent's scenario path twice (cold, warm) and prints
 * timings + a per-query timeline as one JSON line.
 * Usage: first-request-child.ts <latencyMs> [path]
 */

import {
  type Client,
  createClient,
  type InStatement,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { setDb } from "#db/client.ts";
import { beginTransaction, wrapExecute } from "#db/libsql-call.ts";
import { timedRunner } from "#scripts/timed-run.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { setSuppressRequestLogs } from "#shared/logger.ts";
import { delay } from "#shared/now.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import {
  setBuildCommitForTest,
  setBuildTimestampForTest,
} from "#shared/update.ts";
import { bunnyServeHandler } from "#src/serve-app.ts";
import { serveAndDrain } from "./serve-request.ts";
import {
  benchmarkBookingMarkers,
  benchmarkCatalogueMarkers,
  requiredEnv,
  requireMarkers,
} from "./support.ts";

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
const path = Deno.args[1] ?? "/listings";
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
  before: async () => {
    if (latencyMs > 0) await delay(latencyMs);
  },
});

const statementSql = (statement: InStatement): string =>
  typeof statement === "string" ? statement : statement.sql;

/** The `execute` override for a wrapped client or transaction — runs either
 * overload through the delay + timeline. */
const recordedExecute = (target: Pick<Client, "execute">) =>
  wrapExecute(target, (statement, execute) =>
    record(statementSql(statement), execute),
  );

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
        await record("BEGIN", () => beginTransaction(client, mode)),
      ),
  });

setDb(wrapClient(createClient({ url: requiredEnv("DB_URL") })));

const timedRequest = async (): Promise<{ ms: number; status: number }> => {
  requestStart = performance.now();
  const response = await serveAndDrain(bunnyServeHandler, path);
  const ms = performance.now() - requestStart;
  // A booking page carries the nav for its own target instead of the whole
  // catalogue, so its completeness markers differ from the listings page's.
  const markers = path.startsWith("/ticket/")
    ? benchmarkBookingMarkers()
    : benchmarkCatalogueMarkers();
  requireMarkers(response, `GET ${path}`, markers);
  return { ms, status: response.status };
};

const first = await timedRequest();
const firstTimeline = [...timeline];
timeline.length = 0;
const second = await timedRequest();

console.log(
  JSON.stringify({
    firstMs: first.ms,
    firstRoundTrips: firstTimeline.length,
    firstStatus: first.status,
    firstTimeline,
    latencyMs,
    secondMs: second.ms,
    secondRoundTrips: timeline.length,
    secondStatus: second.status,
    secondTimeline: timeline,
  }),
);
