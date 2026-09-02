/**
 * Cold-start benchmark 2: the first request's database round trips.
 * Prepares a migrated, setup-complete database file, then per simulated
 * latency spawns fresh children whose libsql clients delay every round trip;
 * each child serves `GET /listings` twice (cold, warm) and reports a query
 * timeline. The prepared catalogue includes enough regular groups to expose
 * query fan-out that grows with the number of groups.
 * The slope of "first request" against latency = sequential round trips.
 *
 * Run with: deno run -A scripts/bench/cold-start/first-request.ts
 */

import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";
import { emptyListsFor } from "#fp";
import { serveAndDrain } from "./serve-request.ts";
import { spawnChildJson } from "./spawn-child.ts";
import { median, medianAbsoluteDeviation } from "./strip-lib.ts";
import {
  BENCHMARK_PACKAGE_GROUPS,
  BENCHMARK_REGULAR_GROUPS,
  balancedCycles,
  balancedRotation,
  benchmarkGroupName,
  benchmarkListingName,
  requireBenchmarkCatalogue,
  requiredEnv,
  samplesFor,
} from "./support.ts";

const LATENCIES_MS = [0, 5, 10, 20];
const RUNS = 8;
// Fake deploy markers so recordScriptVersion() takes its steady-state path.
const BUILD_ISO = "2026-01-01T00:00:00.000Z";
const BUILD_COMMIT = "benchmark0";

const log = console.log.bind(console);

/** Add the public catalogue whose group count makes query scaling visible. */
const seedCatalogue = async (): Promise<void> => {
  const { groups, setListingGroups } = await import("#db/groups.ts");
  const { listingsTable } = await import("#db/listings/records.ts");
  const { hmacHash } = await import("#crypto/hashing.ts");

  const addGroupWithListing = async (
    number: number,
    isPackage: boolean,
  ): Promise<void> => {
    const kind = isPackage ? "package" : "group";
    const slug = `benchmark-${kind}-${number}`;
    const group = await groups.table.insert({
      isPackage,
      name: benchmarkGroupName(number, isPackage),
      slug,
      slugIndex: await hmacHash(slug),
    });
    const listingSlug = `benchmark-listing-${number}`;
    const listing = await listingsTable.insert({
      maxAttendees: 100,
      maxPrice: 0,
      name: benchmarkListingName(number),
      slug: listingSlug,
      slugIndex: await hmacHash(listingSlug),
    });
    await setListingGroups(listing.id, [group.id]);
  };

  for (let number = 1; number <= BENCHMARK_REGULAR_GROUPS; number++) {
    await addGroupWithListing(number, false);
  }
  for (let number = 1; number <= BENCHMARK_PACKAGE_GROUPS; number++) {
    await addGroupWithListing(BENCHMARK_REGULAR_GROUPS + number, true);
  }
};

/** Create and fully migrate a database file, then complete site setup. */
const prepareDatabase = async (): Promise<void> => {
  // Dynamic imports: nothing may read the environment before main sets it.
  const { createClient } = await import("@libsql/client");
  const { setAdminFeatureEnabled } = await import("#db/admin-features.ts");
  const { setDb } = await import("#db/client.ts");
  const { initDb } = await import("#db/migrations.ts");
  const { settings } = await import("#db/settings.ts");
  const { setFastPbkdf2ForTest } = await import("#crypto/hashing.ts");
  const { setRsaKeySizeForTest } = await import("#crypto/keys.ts");
  const { setSuppressDebugLogs } = await import("#shared/log-settings.ts");
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
  setDb(createClient({ url: requiredEnv("DB_URL") }));
  await initDb({ allowMissingSettings: true });
  await settings.setup.complete("benchadmin", "bench-password-123", "GB");
  await setAdminFeatureEnabled("site", true);
  await seedCatalogue();

  // Stamp the markers as an earlier isolate of this deploy would have.
  setBuildTimestampForTest(BUILD_ISO);
  setBuildCommitForTest(BUILD_COMMIT);
  await recordScriptVersion();

  // One warm-up request so first-ever housekeeping (prune stamps, backfill
  // markers) lands in prep, not in a measured child.
  const { serveHandler } = await import("#src/serve-app.ts");
  const response = await serveAndDrain(serveHandler, "/listings");
  requireBenchmarkCatalogue(response, "database preparation request");
};

type QueryEvent = { ms: number; sql: string; startOffsetMs: number };

type ChildReport = {
  firstMs: number;
  firstRoundTrips: number;
  firstStatus: number;
  firstTimeline: QueryEvent[];
  latencyMs: number;
  secondMs: number;
  secondRoundTrips: number;
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
  if (report.firstStatus !== 200 || report.secondStatus !== 200) {
    throw new Error(`listings request at ${latencyMs}ms did not return 200`);
  }
  return report;
};

const medianReport = (reports: ChildReport[]): ChildReport => {
  const firstMs = median(reports.map((report) => report.firstMs));
  const closest = reports.toSorted(
    (a, b) => Math.abs(a.firstMs - firstMs) - Math.abs(b.firstMs - firstMs),
  )[0];
  if (!closest) throw new Error("No benchmark reports");
  return {
    ...closest,
    firstMs,
    firstRoundTrips: median(reports.map((report) => report.firstRoundTrips)),
    secondMs: median(reports.map((report) => report.secondMs)),
    secondRoundTrips: median(reports.map((report) => report.secondRoundTrips)),
  };
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

const meanOf = <T>(
  values: readonly T[],
  numberFrom: (value: T) => number,
): number =>
  values.reduce((sum, value) => sum + numberFrom(value), 0) / values.length;

const requestSlope = (
  reports: readonly ChildReport[],
  durationOf: (report: ChildReport) => number,
): number => {
  const meanLatency = meanOf(reports, (report) => report.latencyMs);
  const meanDuration = meanOf(reports, durationOf);
  const covariance = meanOf(
    reports,
    (report) =>
      (report.latencyMs - meanLatency) * (durationOf(report) - meanDuration),
  );
  const latencyVariance = meanOf(
    reports,
    (report) => (report.latencyMs - meanLatency) ** 2,
  );
  return covariance / latencyVariance;
};

const balancedRequestSlope = (
  runs: readonly ChildReport[][],
  durationOf: (report: ChildReport) => number,
): number =>
  median(
    balancedCycles(runs, LATENCIES_MS.length).map((cycle) => {
      const slopes = cycle.map((run) => requestSlope(run, durationOf));
      return meanOf(slopes, (slope) => slope);
    }),
  );

const printReport = (
  reports: ChildReport[],
  runs: readonly ChildReport[][],
): void => {
  log(
    `\nGET /listings medians of ${RUNS} fresh processes per latency ` +
      `(${BENCHMARK_REGULAR_GROUPS} regular groups, ${BENCHMARK_PACKAGE_GROUPS} packages):\n`,
  );
  log(
    `${"latency".padEnd(10)}${"first req".padStart(12)}${"round trips".padStart(13)}` +
      `${"second req".padStart(13)}${"round trips".padStart(13)}`,
  );
  for (const r of reports) {
    const latencyIndex = LATENCIES_MS.indexOf(r.latencyMs);
    const completeSamples = runs.map((run) => {
      const sample = run[latencyIndex];
      if (!sample) throw new Error(`Samples missing for ${r.latencyMs}ms`);
      return sample;
    });
    log(
      `${`${r.latencyMs}ms`.padEnd(10)}${`${r.firstMs.toFixed(0)}ms`.padStart(12)}` +
        `${String(r.firstRoundTrips).padStart(13)}` +
        `${`${r.secondMs.toFixed(0)}ms`.padStart(13)}` +
        `${String(r.secondRoundTrips).padStart(13)}` +
        `   (MAD ${medianAbsoluteDeviation(completeSamples.map((sample) => sample.firstMs)).toFixed(1)}` +
        `/${medianAbsoluteDeviation(completeSamples.map((sample) => sample.secondMs)).toFixed(1)}ms)`,
    );
  }
  const worst = reports[reports.length - 1];
  if (!worst) return;
  const coldDepth = balancedRequestSlope(runs, (report) => report.firstMs);
  const warmDepth = balancedRequestSlope(runs, (report) => report.secondMs);
  log(
    "\nMedian balanced-cycle sequential round trips from four-point slopes: " +
      `~${coldDepth.toFixed(1)} cold, ~${warmDepth.toFixed(1)} warm`,
  );
  log("\nRaw request samples (cold / warm ms):");
  for (const [index, latency] of LATENCIES_MS.entries()) {
    log(
      `  ${latency}ms: ${runs
        .map((run) => {
          const report = run[index];
          if (!report) throw new Error(`Report missing for ${latency}ms`);
          return `${report.firstMs.toFixed(1)} / ${report.secondMs.toFixed(1)}`;
        })
        .join(", ")}`,
    );
  }
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

    const samples = emptyListsFor<number, ChildReport>(LATENCIES_MS);
    const runs: ChildReport[][] = [];
    // Balanced rotation: every latency occupies every position twice.
    for (let run = 0; run < RUNS; run++) {
      const reportsByLatency = new Map<number, ChildReport>();
      for (const latency of balancedRotation(LATENCIES_MS, run)) {
        const report = await runChild(latency, env);
        samplesFor(samples, latency).push(report);
        reportsByLatency.set(latency, report);
      }
      runs.push(
        LATENCIES_MS.map((latency) => {
          const report = reportsByLatency.get(latency);
          if (!report) throw new Error(`Report missing for ${latency}ms`);
          return report;
        }),
      );
    }
    printReport(
      LATENCIES_MS.map((latency) => medianReport(samplesFor(samples, latency))),
      runs,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

await main();
