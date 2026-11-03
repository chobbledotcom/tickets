#!/usr/bin/env -S deno run --allow-read=src,scripts/check-call-chains/registry.json --allow-env --allow-sys --allow-ffi --allow-write=scripts/check-call-chains/registry.json

/**
 * Find the chains of three or more methods that repeat at two or more sites in
 * `src/`, and hold each chain to its recorded site count in
 * `scripts/check-call-chains/registry.json` (see "Keep methods flat" in
 * AGENTS.md). Run as part of the merge checks, or on its own with
 * `deno task check:call-chains`. Pass `--update` after writing a helper to
 * re-record the counts. The update refuses a count that rose, so a rise must
 * be removed first. A removed entry can no longer be recorded anew.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import {
  countsRose,
  readCounts,
  recordedState,
  updateMode,
} from "#scripts/check-runner.ts";
import { repeatedChains, runCallChainCheck } from "./check-call-chains/run.ts";

/** The tree the check reads. */
const ROOTS = ["src"];

const REGISTRY_PATH = new URL(
  "./check-call-chains/registry.json",
  import.meta.url,
).pathname;

const accepted = await recordedState(
  REGISTRY_PATH,
  updateMode(Deno.args),
  await readCounts(REGISTRY_PATH),
  () => repeatedChains(ROOTS),
  countsRose,
);

Deno.exit(await runCallChainCheck(ROOTS, accepted, consoleOutput));
