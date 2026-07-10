/**
 * Cold-start benchmark 2: the first request's database round trips.
 * Prepares a migrated, setup-complete database file, then per simulated
 * latency spawns a fresh child whose libsql client delays every statement;
 * the child serves `GET /` twice (cold, warm) and reports a query timeline.
 * The slope of "first request" against latency = sequential round trips.
 *
 * Run with: deno run -A scripts/bench/cold-start/first-request.ts
 */

import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";
import { spawnChildJson } from "./spawn-child.ts";

const LATENCIES_MS = [0, 25, 50, 100];
// Fake deploy markers so recordScriptVersion() takes its steady-state path.
const BUILD_ISO = "2026-01-01T00:00:00.000Z";
const BUILD_COMMIT = "benchmark0";

const log = console.log.bind(console);

/** Create and fully migrate a database file, then complete site setup. */
const prepareDatabase = async (): Promise<void> => {
  // Dynamic imports: nothing may read the environment before main sets it.
  const { createClient } = await import("@libsql/client");
  const { setDb } = await import("#shared/db/client.ts");
  const { initDb } = await import("#shared/db/migrations.ts");
  const { settings } = await import("#shared/db/settings.ts");
  const { setFastPbkdf2ForTest } = await import("#shared/crypto/hashing.ts");
  const { setRsaKeySizeForTest } = await import("#shared/crypto/keys.ts");
  const { setSuppressDebugLogs } = await import("#shared/logger.ts");
  const {
    recordScriptVersion,
    setBuildCommitForTest,
    setBuildTimestampForTest,
  } = await import("#shared/update.ts");

  // Weaker prep-only crypto; the child never logs in, so unmeasured.
  setFastPbkdf2ForTest(true);
  setRsaKeySizeForTest(1024);
  setSuppressDebugLogs(true);

  // `main` sets DB_URL before calling prepareDatabase.
  setDb(createClient({ url: Deno.env.get("DB_URL")! }));
  await initDb({ allowMissingSettings: true });
  await settings.setup.complete("benchadmin", "bench-password-123", "GB");

  // Stamp the markers as an earlier isolate of this deploy would have.
  setBuildTimestampForTest(BUILD_ISO);
  setBuildCommitForTest(BUILD_COMMIT);
  await recordScriptVersion();

  // One warm-up request so first-ever housekeeping (prune stamps, backfill
  // markers) lands in prep, not in a measured child.
  const { serveHandler } = await import("#src/serve-app.ts");
  const response = await serveHandler(new Request("http://localhost/"));
  await response.text();
  requireHealthyStatus(response.status, "database preparation request");
};

/**
 * A broken site must fail the benchmark, not produce plausible timings —
 * the production handler turns unhandled errors into error pages, so status
 * is the only failure signal. `GET /` legitimately redirects (302), so
 * anything below 400 counts as healthy.
 */
const requireHealthyStatus = (status: number, what: string): void => {
  if (status >= 400) throw new Error(`${what} failed with status ${status}`);
};

type QueryEvent = { ms: number; sql: string; startOffsetMs: number };

type ChildReport = {
  firstMs: number;
  firstQueryCount: number;
  firstStatus: number;
  firstTimeline: QueryEvent[];
  latencyMs: number;
  secondMs: number;
  secondQueryCount: number;
  secondStatus: number;
  secondTimeline: QueryEvent[];
};

const runChild = async (
  latencyMs: number,
  env: Record<string, string>,
): Promise<ChildReport> => {
  // Generous timeout: a hung child must fail the sweep, not stall it.
  const report = await spawnChildJson<ChildReport>(
    [
      "run",
      "--quiet",
      "--no-check",
      "-A",
      "scripts/bench/cold-start/first-request-child.ts",
      String(latencyMs),
    ],
    env,
    120_000,
    `first-request child at ${latencyMs}ms latency`,
  );
  requireHealthyStatus(report.firstStatus, `cold request at ${latencyMs}ms`);
  requireHealthyStatus(report.secondStatus, `warm request at ${latencyMs}ms`);
  return report;
};

const printTimeline = (report: ChildReport): void => {
  log(
    `\nCold-request query timeline at ${report.latencyMs}ms simulated latency` +
      " (offsets from request start):",
  );
  for (const event of report.firstTimeline) {
    log(
      `  +${event.startOffsetMs.toFixed(0).padStart(4)}ms  ` +
        `(${event.ms.toFixed(0)}ms)  ${event.sql}`,
    );
  }
};

const printReport = (reports: ChildReport[]): void => {
  log("\nFirst vs second request on one isolate (fresh process per row):\n");
  log(
    `${"latency".padEnd(10)}${"first req".padStart(12)}${"queries".padStart(10)}` +
      `${"second req".padStart(13)}${"queries".padStart(10)}`,
  );
  for (const r of reports) {
    log(
      `${`${r.latencyMs}ms`.padEnd(10)}${`${r.firstMs.toFixed(0)}ms`.padStart(12)}` +
        `${String(r.firstQueryCount).padStart(10)}` +
        `${`${r.secondMs.toFixed(0)}ms`.padStart(13)}` +
        `${String(r.secondQueryCount).padStart(10)}` +
        `   (status ${r.firstStatus}/${r.secondStatus})`,
    );
  }
  const zero = reports.find((r) => r.latencyMs === 0);
  const worst = reports[reports.length - 1];
  if (!zero || !worst || worst.latencyMs === 0) return;
  const coldDepth = (worst.firstMs - zero.firstMs) / worst.latencyMs;
  const warmDepth = (worst.secondMs - zero.secondMs) / worst.latencyMs;
  log(
    "\nSequential round trips implied by the slope: " +
      `~${coldDepth.toFixed(1)} cold, ~${warmDepth.toFixed(1)} warm`,
  );
  printTimeline(worst);
};

const main = async (): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "cold-start-bench" });
  const env = {
    // The child re-applies the same fake build markers the prep recorded.
    BENCH_BUILD_COMMIT: BUILD_COMMIT,
    BENCH_BUILD_ISO: BUILD_ISO,
    DB_ENCRYPTION_KEY: encodeBase64(crypto.getRandomValues(new Uint8Array(32))),
    DB_URL: `file:${dir}/bench.db`,
  };
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  // Prep runs in this process: drop shell variables that would fail boot
  // checks or add network calls (children get a clean env separately).
  for (const key of ["MAIN_INSTANCE_KEY", "SENTRY_URL"]) Deno.env.delete(key);

  try {
    log("Preparing migrated, setup-complete database file...");
    await prepareDatabase();

    const reports: ChildReport[] = [];
    for (const latency of LATENCIES_MS) {
      reports.push(await runChild(latency, env));
    }
    printReport(reports);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

await main();
