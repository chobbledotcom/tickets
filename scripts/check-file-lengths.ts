#!/usr/bin/env -S deno run --allow-read=src,test,scripts,cli,e2e-payments --allow-write=scripts/check-file-lengths/over-limit.json

/**
 * Check the source trees for files over the ~400-line limit (see "Keep code
 * and test files under ~400 lines" in AGENTS.md), against the accepted list in
 * `scripts/check-file-lengths/over-limit.json`. Run as part of
 * `deno task precommit`, or on its own with `deno task check:file-lengths`.
 * Pass `--update` after splitting a file to re-record the list; it refuses to
 * write a list entry that grew, so growth must be split first. Pass `--seed`
 * only when the limit itself changed and the list must be recorded anew.
 */

import {
  filesOverLimit,
  runFileLengthCheck,
  SOURCE_DIRS,
} from "./check-file-lengths/run.ts";
import { consoleOutput } from "./check-report.ts";
import {
  countsRose,
  readCounts,
  recordedState,
  updateMode,
} from "./check-runner.ts";

const LIST_PATH = new URL(
  "./check-file-lengths/over-limit.json",
  import.meta.url,
).pathname;

const overLimit = await recordedState(
  LIST_PATH,
  updateMode(Deno.args),
  await readCounts(LIST_PATH),
  () => filesOverLimit(SOURCE_DIRS),
  countsRose,
);

Deno.exit(await runFileLengthCheck(SOURCE_DIRS, overLimit, consoleOutput));
