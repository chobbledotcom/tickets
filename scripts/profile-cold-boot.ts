/**
 * Cold Boot Performance Profiler
 *
 * Measures the timing of various initialization phases to identify bottlenecks.
 * Run with: deno run -A scripts/profile-cold-boot.ts
 */

import { createClient } from "@libsql/client";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { timedRunner } from "./timed-run.ts";

interface Timing {
  duration: number;
  name: string;
}

const timings: Timing[] = [];

const pushTiming = (name: string, ms: number): void => {
  timings.push({ duration: ms, name });
};

const measure = timedRunner({
  after: (name, _startedAt, ms) => pushTiming(name, ms),
});

const measureSync = <T>(name: string, fn: () => T): T => {
  const start = performance.now();
  const result = fn();
  pushTiming(name, performance.now() - start);
  return result;
};

const log = console.log.bind(console);

/** Time one `initDb` call — used cold (creates tables) and warm (bails on the
 * version check), which differ only in the name and options. */
const measureInitDb = (
  name: string,
  options?: { allowMissingSettings: boolean },
): Promise<void> =>
  measure(name, async () => {
    const { initDb } = await import("#shared/db/migrations.ts");
    await initDb(options);
  });

/**
 * Time a cached call: one cold `call()` (queries + caches) then five warm ones,
 * logging the first-call cost, the warm average, and the speedup.
 */
const profileCaching = async (call: () => Promise<unknown>): Promise<void> => {
  const firstStart = performance.now();
  await call();
  const firstDuration = performance.now() - firstStart;
  log(`  First call (queries DB + caches): ${firstDuration.toFixed(2)}ms`);

  const cachedTimings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await call();
    cachedTimings.push(performance.now() - start);
  }
  const avgCached =
    cachedTimings.reduce((a, b) => a + b, 0) / cachedTimings.length;
  log(`  Cached calls (avg of 5): ${avgCached.toFixed(4)}ms`);
  log(`  ✅ ${(firstDuration / avgCached).toFixed(0)}x faster with caching!\n`);
};

const printReport = () => {
  log(`\n${"=".repeat(60)}`);
  log("COLD BOOT PERFORMANCE PROFILE");
  log("=".repeat(60));

  let total = 0;
  for (const { name, duration } of timings) {
    const ms = duration.toFixed(2);
    const bar = "█".repeat(Math.min(50, Math.ceil(duration / 2)));
    log(`\n${name}`);
    log(`  ${ms}ms ${bar}`);
    total += duration;
  }

  log(`\n${"-".repeat(60)}`);
  log(`TOTAL: ${total.toFixed(2)}ms`);

  if (total > 500) {
    log("\n⚠️  WARNING: Total exceeds Bunny's 500ms startup limit!");
  } else {
    log(`\n✅ Within 500ms limit (${((total / 500) * 100).toFixed(1)}% used)`);
  }

  log(`${"=".repeat(60)}\n`);
};

const main = async () => {
  log("Profiling cold boot performance...\n");

  // Use in-memory DB to isolate JS overhead from network latency
  const client = createClient({ url: ":memory:" });

  // 1. Measure module imports (simulating fresh boot)
  await measure("1. Import @libsql/client", async () => {
    // Already imported above, but this simulates the cost
    await import("@libsql/client");
  });

  // 2. Measure encryption key setup
  measureSync("2. Setup encryption key + validate", () => {
    setupTestEncryptionKey();
  });

  // 3. Measure DB client creation
  await measure("3. Import db/client + set client", async () => {
    const { setDb } = await import("#shared/db/client.ts");
    setDb(client);
  });

  // 4. Measure initDb (first run - creates tables)
  await measureInitDb("4. initDb (cold - creates tables)", {
    allowMissingSettings: true,
  });

  // 5. Measure initDb (warm - bails early)
  await measureInitDb("5. initDb (warm - version check only)");

  // 6. Measure isSetupComplete query
  await measure("6. isSetupComplete() query", async () => {
    const { settings } = await import("#shared/db/settings.ts");
    await settings.setup.isComplete();
  });

  // 7. Measure route module loading
  await measure("7. Import routes/index.ts", async () => {
    await import("#routes/index.ts");
  });

  // 8. Measure admin routes (lazy load)
  await measure("8. Import routes/admin (lazy)", async () => {
    await import("#routes/admin/index.ts");
  });

  // 9. Measure public routes (lazy load)
  await measure("9. Import routes/public (lazy)", async () => {
    await import("#routes/public/ticket-routes.ts");
  });

  // Print the report
  printReport();

  // Complete setup to test caching
  log("Completing setup to test caching...\n");
  const { settings } = await import("#shared/db/settings.ts");
  await settings.setup.complete("profileuser", "testpassword", "GBP");

  // Test isSetupComplete caching (before it's cached)
  log("Testing isSetupComplete() caching:\n");

  // First call after setup - should query DB and cache
  await profileCaching(() => settings.setup.isComplete());

  // Test session caching
  log("Testing session caching (10s TTL):\n");
  const { createSession, getSession } = await import("#shared/db/sessions.ts");

  // Create a session (no wrapped data key; the setup-created user is id 1)
  await createSession("test-token", "test-csrf", Date.now() + 3600000, null, 1);

  await profileCaching(() => getSession("test-token"));

  // Network latency reality check
  log("=".repeat(60));
  log("NETWORK LATENCY IMPACT (ESTIMATED)");
  log("=".repeat(60));
  log(`
The above measurements use an in-memory database.
In production with Turso, each DB query adds network latency.

Typical latency ranges:
  - Same region:     20-50ms per query
  - Cross-region:    50-150ms per query
  - Global edge:     100-300ms per query

With caching optimizations:
  - isSetupComplete(): Cached permanently after first true result
    → Cold start: 1 query, Warm requests: 0 queries
  - Session validation: Cached for 10 seconds
    → Reduces ~50ms per request to ~0ms for repeat checks

Estimated cold start with network:
  JS overhead:       ~30ms
  initDb query:      ~50ms (same region)
  isSetupComplete:   ~50ms (same region, then cached)
  Route loading:     ~25ms
  ─────────────────────────
  TOTAL:             ~155ms (cold)

Per warm request (after first):
  isSetupComplete:   ~0ms (cached!)
  Session check:     ~0ms (cached for 10s) or ~50ms (cache miss)
  + Business logic queries
`);
};

main().catch(console.error);
