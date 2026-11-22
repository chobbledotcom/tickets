#!/usr/bin/env -S deno run --allow-read=. --allow-write=scripts/check-test-internals/registry.json --allow-sys --allow-run=git

/**
 * Hold every test file to its recorded count of imports from `src/`
 * internals, and hold the registry to the merge base on `origin/main`. The
 * counts only fall. Pass `--update` after a fix to record the fallen counts.
 * The update refuses a rise. Run as part of `deno task precommit`, or on its
 * own with `deno task check:test-internals`. See "Keep tests on the public
 * surface" in AGENTS.md.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import { countsCheckExit } from "#scripts/check-runner.ts";
import { ratchetExit } from "./check-test-internals/ratchet-run.ts";
import {
  freshCounts,
  loadContext,
  REGISTRY_PATH,
  runInternalsCheck,
} from "./check-test-internals/run.ts";
import {
  BLACKBOX_DIR,
  SEAM_MODULES,
  SKIPPED_TREES,
} from "./check-test-internals/seam.ts";
import { runCommand } from "./precommit/git.ts";

const context = await loadContext({
  blackboxDir: BLACKBOX_DIR,
  configPath: "deno.json",
  seam: SEAM_MODULES,
  skippedTrees: SKIPPED_TREES,
  sourceRoot: "src",
});
const registryCode = await countsCheckExit(
  import.meta.url,
  "./check-test-internals/registry.json",
  Deno.args,
  ["test"],
  (roots) => freshCounts(roots, context),
  runInternalsCheck(context),
);
const ratchetCode = await ratchetExit({
  output: consoleOutput,
  readRegistryText: () => Deno.readTextFile(REGISTRY_PATH),
  run: runCommand,
});
Deno.exit(registryCode === 0 ? ratchetCode : registryCode);
