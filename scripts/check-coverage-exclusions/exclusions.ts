/**
 * The files the coverage gate does not enforce line and branch coverage on.
 * Data for `scripts/coverage-check.ts`, kept apart so the exclusion ratchet
 * (`scripts/check-coverage-exclusions.ts`) can diff this list against the
 * merge base.
 *
 * The list only ever shrinks: a branch must not add an entry, because an
 * exclusion hides a coverage gap instead of fixing it. A reader who needs to
 * answer a gap restructures the code so the coverage merge reads it (see
 * docs/designing-systems.md). Remove an entry as soon as its reason is gone.
 */

export const COVERAGE_EXCLUSIONS: readonly string[] = [
  // The reporter's own IO edges — spawning a real deno test child and the
  // paths around reading its streams — cannot all be reached from an
  // in-process test, and the branches only guard those edges.
  "scripts/compact-test-reporter.ts",
  "src/shared/db/migrations.ts",
  // Harness infrastructure: inside a harness run every isolate takes the
  // prebuilt-snapshot arm, and outside one only the build-it-here arm runs,
  // so no single coverage run can reach both. The round-trip behaviour is
  // unit-tested in test/test-utils/test-state.test.ts.
  "test/test-utils/test-state.ts",
  // Harness infrastructure, same shape as the line above: the harness has
  // already made the assets current before any test isolate starts, so inside
  // a coverage run only the "already up to date" arm can ever be taken —
  // rebuilding the shared assets mid-run to reach the other one would race
  // every isolate still loading them. What is left in the file is wiring: the
  // choice itself is buildOrReuseStaticAssets, and it and
  // staticAssetsAreUpToDate are both unit-tested, each arm, in
  // test/scripts/static-asset-cache.test.ts.
  "scripts/static-assets/prepare.ts",
  // The e2e-payments config snapshot reads env vars at module-load time. The
  // bool/num helpers and the forceTunnel/needsTunnel branches are exercised by
  // the live Cucumber free target run plus the direct secrets/config-log tests,
  // but coverage only sees the module-load path the test runner took —
  // not the alternative env states the harness boots in for each target.
  "e2e-payments/src/config.ts",
  // Deno's coverage merger mis-attributes this file once several test
  // isolates load it: the merged lcov records FNDA:34,leadingWhitespaceLength
  // while the function's own body line reads DA:16,0 — internally impossible.
  // The parser genuinely runs (the reporter tests assert the messages and
  // locations it extracts from JSON and YAML diagnostic blocks), and the
  // mutation gate still mutates the file against its direct tests.
  "scripts/tap-diagnostics.ts",
  // Deno's coverage merger mis-attributes this file once many test isolates
  // load it: the merged lcov records FNDA:2,resumeRejectedTarget while the
  // function's own body lines read as unhit — internally impossible. The
  // resume guards are genuinely executed (placeholder-completion's crashed
  // redelivery replays them; a two-file run reports DA:150,1 and DA:153,3),
  // and the mutation gate still mutates the file against its direct tests.
  "src/features/api/payment-processing/rejected-target.ts",
  // parseLiveTarget's throw path is tested in test/e2e-payments/parse-target, but
  // the test runner's group system may not pair it into the same isolate as the
  // coverage probe — the function is also covered by the live Cucumber run.
  "e2e-payments/src/targets.ts",
  // The live Cucumber harness: real app servers, tunnels, provider sandboxes
  // and Chromium sessions. Only the nightly workflow can execute these; the
  // step-coverage test imports the support modules (which pull these files
  // in), so a coverage run sees them loaded-but-untested. The pure helpers
  // with deterministic behaviour (cleanup, db-fault, refund-outcome) stay
  // under normal coverage and are directly tested under test/e2e-payments/.
  "e2e-payments/src/browser.ts",
  "e2e-payments/src/flow.ts",
  "e2e-payments/src/listing-flow.ts",
  "e2e-payments/src/order-flow.ts",
  "e2e-payments/src/server.ts",
  "e2e-payments/src/tunnel.ts",
  "e2e-payments/src/util.ts",
  "e2e-payments/src/providers/card.ts",
  "e2e-payments/src/providers/shared.ts",
  "e2e-payments/src/providers/square.ts",
  "e2e-payments/src/providers/stripe.ts",
  "e2e-payments/src/providers/sumup.ts",
  "e2e-payments/src/providers/sumup-callback.ts",
  "e2e-payments/src/cucumber/support/hooks.ts",
  "e2e-payments/src/cucumber/support/journal.ts",
  "e2e-payments/src/cucumber/support/world.ts",
  "e2e-payments/src/cucumber/steps/booking.ts",
  "e2e-payments/src/cucumber/steps/pages.ts",
  "e2e-payments/src/cucumber/steps/refund.ts",
  "e2e-payments/src/cucumber/steps/setup.ts",
  "e2e-payments/src/cucumber/steps/site-plan.ts",
  // Deno's coverage merger mis-attributes this file once several test
  // isolates load it: the merged lcov reads the lazyRef's inner arrow (the
  // lazyRef destructure) as unhit while the sibling module-load lines read
  // as hit — internally impossible, since the lines execute in one
  // statement. Every line and branch is exercised by the three direct
  // suites that import the helper (declarations, type-visitor, visitor),
  // which report the file at 100% when they run alone, and the mutation
  // gate still mutates it against those tests.
  "test/scripts/unread-fields/fields/fields-of-source.ts",
];
