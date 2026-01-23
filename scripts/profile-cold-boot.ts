/**
 * Cold Boot Performance Profiler
 *
 * Measures the timing of various initialization phases to identify bottlenecks.
 * Run with: bun scripts/profile-cold-boot.ts
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

const printReport = () => {
  console.log("\n" + "=".repeat(60));
  console.log("COLD BOOT PERFORMANCE PROFILE");
  console.log("=".repeat(60));

  let total = 0;
  for (const { name, duration } of timings) {
    const ms = duration.toFixed(2);
    const bar = "█".repeat(Math.min(50, Math.ceil(duration / 2)));
    console.log(`\n${name}`);
    console.log(`  ${ms}ms ${bar}`);
    total += duration;
  }

  console.log("\n" + "-".repeat(60));
  console.log(`TOTAL: ${total.toFixed(2)}ms`);

  if (total > 500) {
    console.log("\n⚠️  WARNING: Total exceeds Bunny's 500ms startup limit!");
  } else {
    console.log(`\n✅ Within 500ms limit (${((total / 500) * 100).toFixed(1)}% used)`);
  }

  console.log("=".repeat(60) + "\n");
};

const main = async () => {
  console.log("Profiling cold boot performance...\n");

  // Set up test environment
  process.env.ALLOWED_DOMAIN = "localhost";

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

  // Simulate multiple "warm" requests
  console.log("\nSimulating 5 warm requests (isSetupComplete only):\n");

  const { isSetupComplete } = await import("#lib/db/settings.ts");
  const warmTimings: number[] = [];

  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await isSetupComplete();
    const duration = performance.now() - start;
    warmTimings.push(duration);
    console.log(`  Request ${i + 1}: ${duration.toFixed(2)}ms`);
  }

  const avgWarm = warmTimings.reduce((a, b) => a + b, 0) / warmTimings.length;
  console.log(`\n  Average per-request overhead: ${avgWarm.toFixed(2)}ms`);
  console.log("  (This query runs on EVERY request, even when warm)\n");

  // Network latency reality check
  console.log("=".repeat(60));
  console.log("NETWORK LATENCY IMPACT (ESTIMATED)");
  console.log("=".repeat(60));
  console.log(`
The above measurements use an in-memory database.
In production with Turso, each DB query adds network latency.

Typical latency ranges:
  - Same region:     20-50ms per query
  - Cross-region:    50-150ms per query
  - Global edge:     100-300ms per query

Current per-request DB queries:
  1. initDb version check (cold start only)
  2. isSetupComplete() (EVERY request)

Estimated cold start with network:
  JS overhead:       ~30ms
  initDb query:      ~50ms (same region)
  isSetupComplete:   ~50ms (same region)
  Route loading:     ~25ms
  ─────────────────────────
  TOTAL:             ~155ms (cold)

Per warm request:
  isSetupComplete:   ~50ms (same region)
  + Business logic queries

Recommendation:
  The isSetupComplete() query on every request is the main
  bottleneck. Consider caching this in memory since setup
  status never changes to 'false' once set to 'true'.
`);
};

main().catch(console.error);
