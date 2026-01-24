/**
 * Cold Boot Performance Profiler
 *
 * Measures the timing of various initialization phases to identify bottlenecks.
 * Run with: deno run -A scripts/profile-cold-boot.ts
 */

import { createClient } from "@libsql/client";
import { setupTestEncryptionKey } from "#test-utils";

interface Timing {
  name: string;
  duration: number;
}

const timings: Timing[] = [];

const measure = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  timings.push({ name, duration });
  return result;
};

const measureSync = <T>(name: string, fn: () => T): T => {
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;
  timings.push({ name, duration });
  return result;
};

// biome-ignore lint/suspicious/noConsole: CLI profiling tool output
const log = console.log.bind(console);

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

  // Set up test environment
  Deno.env.set("ALLOWED_DOMAIN", "localhost");

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
    const { setDb } = await import("#lib/db/client.ts");
    setDb(client);
  });

  // 4. Measure initDb (first run - creates tables)
  await measure("4. initDb (cold - creates tables)", async () => {
    const { initDb } = await import("#lib/db/migrations/index.ts");
    await initDb();
  });

  // 5. Measure initDb (warm - bails early)
  await measure("5. initDb (warm - version check only)", async () => {
    const { initDb } = await import("#lib/db/migrations/index.ts");
    await initDb();
  });

  // 6. Measure isSetupComplete query
  await measure("6. isSetupComplete() query", async () => {
    const { isSetupComplete } = await import("#lib/db/settings.ts");
    await isSetupComplete();
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
    await import("#routes/public.ts");
  });

  // Print the report
  printReport();

  // Complete setup to test caching
  log("Completing setup to test caching...\n");
  const { completeSetup, isSetupComplete } = await import(
    "#lib/db/settings.ts"
  );
  await completeSetup("testpassword", "GBP");

  // Test isSetupComplete caching (before it's cached)
  log("Testing isSetupComplete() caching:\n");

  // First call after setup - should query DB and cache
  const firstStart = performance.now();
  await isSetupComplete();
  const firstDuration = performance.now() - firstStart;
  log(`  First call (queries DB + caches): ${firstDuration.toFixed(2)}ms`);

  // Subsequent calls - should return cached value instantly
  const cachedTimings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await isSetupComplete();
    const duration = performance.now() - start;
    cachedTimings.push(duration);
  }
  const avgCached =
    cachedTimings.reduce((a, b) => a + b, 0) / cachedTimings.length;
  log(`  Cached calls (avg of 5): ${avgCached.toFixed(4)}ms`);
  log(`  ✅ ${(firstDuration / avgCached).toFixed(0)}x faster with caching!\n`);

  // Test session caching
  log("Testing session caching (10s TTL):\n");
  const { createSession, getSession } = await import("#lib/db/sessions.ts");

  // Create a session
  await createSession("test-token", "test-csrf", Date.now() + 3600000);

  // First call - queries DB and caches
  const sessionStart1 = performance.now();
  await getSession("test-token");
  const sessionDuration1 = performance.now() - sessionStart1;
  log(`  First call (queries DB + caches): ${sessionDuration1.toFixed(2)}ms`);

  // Cached calls
  const sessionTimings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await getSession("test-token");
    const duration = performance.now() - start;
    sessionTimings.push(duration);
  }
  const avgSession =
    sessionTimings.reduce((a, b) => a + b, 0) / sessionTimings.length;
  log(`  Cached calls (avg of 5): ${avgSession.toFixed(4)}ms`);
  log(
    `  ✅ ${(sessionDuration1 / avgSession).toFixed(0)}x faster with caching!\n`,
  );

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

// biome-ignore lint/suspicious/noConsole: CLI error output
main().catch(console.error);
