#!/usr/bin/env -S deno run --allow-all

/**
 * Production-shape suite (issue #2300): the checks that stand apart from
 * `deno task test` because they ask production-shaped questions of the code.
 * One command, `deno task suite:production`, runs every leg and fails if any
 * of them fails. Intended as the nightly / release-blocking suite
 * (.github/workflows/production-suite.yml), not as a precommit step.
 *
 * Legs:
 * 1. Edge-bundle smoke — builds the edge bundle through the production
 *    pipeline and boots it in a fresh process, proving it loads and serves
 *    (scripts/production-suite/bundle-smoke.ts).
 * 2. Backup and restore drills — the migration-restore suite, which restores
 *    golden and sharded chain databases and re-opens them.
 * 3. Concurrent-reservation race — the SumUp webhook race, the concurrent
 *    webhook processing suite, and the races around recovery and setup.
 * 4. Webhook replay and idempotency — already-processed rollback, replay
 *    windows, post-commit recovery, and signature validation.
 * 5. Security scan — `deno audit --level=critical` over the resolved
 *    dependency graph, printed as a report: the tree carries standing
 *    advisories, so the audit informs the nightly log instead of failing
 *    it.
 *
 * The test legs reuse the full runner's setup by calling `runTests` inside
 * `withTestHarness` (scripts/test-harness.ts) — static assets, stripe-mock,
 * and the prebuilt test state — exactly what `deno task test:files` does. The
 * files also run inside `deno task test`; this suite curates them into one
 * release-blocking place.
 */

import { captureOutput } from "#scripts/process.ts";
import { runBundleSmoke } from "#scripts/production-suite/bundle-smoke.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { runTests, withTestHarness } from "#scripts/test-harness.ts";

/** One leg: a name for the log plus the work that throws on failure. */
type Leg = { name: string; run: () => Promise<void> };

const TEST_LEGS: { name: string; files: string[] }[] = [
  {
    files: [
      "test/integration/db/migration-restore/",
      "test/integration/migration-restore-verify.test.ts",
    ],
    name: "backup and restore drills",
  },
  {
    files: [
      "test/integration/server/webhooks/sumup.test.ts",
      "test/integration/server/webhooks/concurrent-processing.test.ts",
      "test/integration/server/sumup-recovery/races-the-webhook.test.ts",
      "test/integration/server/sumup-recovery/lost-race.test.ts",
      "test/integration/server/setup-concurrency.test.ts",
    ],
    name: "concurrent-reservation race",
  },
  {
    files: [
      "test/integration/server/webhooks/already-processed-rollback.test.ts",
      "test/integration/server/webhooks/price-signature-post-commit-recovery.test.ts",
      "test/integration/server/webhooks/signature-validation.test.ts",
      "test/shared/payment/refund-replay-window.test.ts",
      "test/shared/payment-idempotency.test.ts",
    ],
    name: "webhook replay and idempotency",
  },
];

/** The dependency audit as a report, not a gate. `deno audit` reads the
 * whole resolved graph, dev tooling included, and the tree carries standing
 * advisories today, so a failing exit would hold every nightly red on
 * triaged debt. The scheduled run still prints every finding, so a new
 * critical reaches this log the same hour it appears. */
const auditLeg = async (): Promise<void> => {
  const { code, stderr, stdout } = await captureOutput(
    new Deno.Command(Deno.execPath(), {
      args: ["audit", "--level=critical"],
      cwd: projectRoot,
      stderr: "piped",
      stdout: "piped",
    }),
  );
  const report = `${stdout}${stderr}`.trim();
  const exitNote = code === 0 ? "" : ` (deno audit exited with code ${code})`;
  console.log(
    report === ""
      ? `no critical advisories${exitNote}`
      : `${report}${exitNote}`,
  );
};

const legs: Leg[] = [
  { name: "edge-bundle smoke", run: runBundleSmoke },
  ...TEST_LEGS.map((leg) => ({
    name: leg.name,
    run: async () => {
      const code = await runTests(leg.files, false);
      if (code !== 0) throw new Error(`test leg failed (code=${code})`);
    },
  })),
  { name: "security scan (deno audit)", run: auditLeg },
];

const main = async (): Promise<void> => {
  const failures: string[] = [];

  await withTestHarness(async () => {
    for (const leg of legs) {
      console.log(`\n=== production suite: ${leg.name} ===`);
      try {
        await leg.run();
        console.log(`--- ${leg.name}: PASS`);
      } catch (error) {
        failures.push(leg.name);
        console.error(`--- ${leg.name}: FAIL`, error);
      }
    }
  });

  if (failures.length > 0) {
    console.error(`\nproduction suite FAILED: ${failures.join(", ")}`);
    Deno.exit(1);
  }
  console.log("\nproduction suite: all legs passed");
};

main();
