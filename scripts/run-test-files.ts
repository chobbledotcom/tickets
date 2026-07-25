#!/usr/bin/env -S deno run --allow-all

/**
 * Focused test runner: reuses the full runner's setup (built static assets +
 * stripe-mock, via the shared test harness) but runs only the test files
 * passed as arguments and skips coverage enforcement. This lets a fresh
 * checkout run a subset of the suite without manual preparation or leftover
 * build artifacts.
 *
 *   deno task test:files test/lib/server-balance.test.ts
 *   deno task test:files test/lib/dates.test.ts --filter "formats date"
 *
 * Arguments are forwarded verbatim to `deno test`, so paths, directories, and
 * flags such as `--filter` all work. At least one argument is required.
 */

import { focusedTargets } from "./specs/options.ts";
import { runTests, withTestHarness } from "./test-harness.ts";

const main = async (): Promise<void> => {
  if (Deno.args.length === 0) {
    console.error(
      "Usage: deno task test:files <test-file> [<test-file>...] [--filter <name>]",
    );
    Deno.exit(1);
  }

  const targets = focusedTargets(Deno.args);
  const exitCode = await withTestHarness(async () => {
    if (targets.testArgs.length > 0) {
      const testCode = await runTests(targets.testArgs, false);
      if (testCode !== 0) return testCode;
    }
    if (targets.specPaths.length > 0) {
      const { runSpecs } = await import("./specs/run.ts");
      const result = await runSpecs({
        paths: targets.specPaths,
        reports: false,
        ...(targets.tags === undefined ? {} : { tags: targets.tags }),
      });
      return result.success ? 0 : 1;
    }
    return 0;
  });
  Deno.exit(exitCode);
};

main();
