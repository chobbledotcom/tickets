/**
 * Cold-start benchmark 2: how much of the first request is database round
 * trips?
 *
 * In production the edge isolate talks to the database over HTTP, so every
 * query costs a full network round trip — and any query that *waits* for the
 * previous one adds its whole latency to the first response. This benchmark
 * prepares a fully migrated, setup-complete database file, then spawns one
 * fresh child process per simulated latency. Each child wraps the libsql
 * client so every statement pays that latency, serves `GET /` twice (cold
 * isolate, then warm), and reports a per-query timeline.
 *
 * Reading the results:
 *   - The slope of "first request" against latency = the number of
 *     *sequential* round trips on the cold path (parallel queries share one).
 *   - The timeline for the slowest run shows exactly which queries chain.
 *
 * Run with: deno run -A scripts/bench/cold-start/first-request.ts
 */

import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";

const LATENCIES_MS = [0, 25, 50, 100];
// Matches what a real deploy bakes in; lets recordScriptVersion() behave
// exactly as it does on a production cold boot (marker reads, no writes).
const BUILD_ISO = "2026-01-01T00:00:00.000Z";
const BUILD_COMMIT = "benchmark0";

const log = console.log.bind(console);

/** Create and fully migrate a database file, then complete site setup. */
const prepareDatabase = async (): Promise<void> => {
  // Imports happen after DB_URL/DB_ENCRYPTION_KEY are set (see main), and
  // dynamically so nothing reads the environment before it is ready.
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

  // Speed up the one-off setup ceremony; the child never logs in, so the
  // weaker prep-only hash and key size cannot affect the measurements.
  setFastPbkdf2ForTest(true);
  setRsaKeySizeForTest(1024);
  setSuppressDebugLogs(true);

  setDb(createClient({ url: Deno.env.get("DB_URL") as string }));
  await initDb({ allowMissingSettings: true });
  await settings.setup.complete("benchadmin", "bench-password-123", "GB");

  // Record the fake build's markers, as the previous deploy of this build
  // would have — the child's cold boot then takes the steady-state path.
  setBuildTimestampForTest(BUILD_ISO);
  setBuildCommitForTest(BUILD_COMMIT);
  await recordScriptVersion();

  // Serve one request here so the first-ever housekeeping (prune stamps,
  // activity-log backfill markers) lands in prep, not in a measured child.
  // Every child then measures the same steady state a production isolate
  // sees: the site is live and some earlier isolate has already pruned.
  const { serveHandler } = await import("#src/serve-app.ts");
  await (await serveHandler(new Request("http://localhost/"))).text();
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
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-check",
      "-A",
      "scripts/bench/cold-start/first-request-child.ts",
      String(latencyMs),
    ],
    env,
    stderr: "inherit",
    stdout: "piped",
  });
  const { code, stdout } = await command.output();
  if (code !== 0) throw new Error(`child failed for latency ${latencyMs}ms`);
  return JSON.parse(new TextDecoder().decode(stdout)) as ChildReport;
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

  log("Preparing migrated, setup-complete database file...");
  await prepareDatabase();

  const reports: ChildReport[] = [];
  for (const latency of LATENCIES_MS) {
    reports.push(await runChild(latency, env));
  }
  printReport(reports);
};

await main();
