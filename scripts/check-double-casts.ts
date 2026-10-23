#!/usr/bin/env -S deno run --allow-read=src,test,scripts,cli,e2e-payments,.opencode/plugins --allow-env --allow-sys --allow-ffi --allow-write=scripts/check-double-casts/baseline.json

/**
 * Check the source trees for `as unknown as` casts (see the "Offensive
 * Programming" rules in AGENTS.md), against the accepted counts in
 * `scripts/check-double-casts/baseline.json`. Run as part of the merge
 * checks, or on its own with `deno task check:double-casts`. Pass `--update`
 * after removing casts to re-record the counts. The update refuses a
 * baseline that rose, so a rise must be removed first. A removed entry can
 * no longer be recorded anew.
 */

import { SOURCE_DIRS } from "#scripts/source-dirs.ts";
import { consoleOutput } from "#scripts/check-report.ts";
import {
  countsRose,
  readCounts,
  recordedState,
  updateMode,
} from "#scripts/check-runner.ts";
import {
  filesWithDoubleCasts,
  runDoubleCastsCheck,
} from "./check-double-casts/run.ts";

const BASELINE_PATH = new URL(
  "./check-double-casts/baseline.json",
  import.meta.url,
).pathname;

const accepted = await recordedState(
  BASELINE_PATH,
  updateMode(Deno.args),
  await readCounts(BASELINE_PATH),
  () => filesWithDoubleCasts(SOURCE_DIRS),
  countsRose,
);

Deno.exit(await runDoubleCastsCheck(SOURCE_DIRS, accepted, consoleOutput));
