#!/usr/bin/env -S deno run --allow-read=. --allow-write=scripts/check-comments/ste-baseline.json

/**
 * Check source comments against the mechanical comment-language rules (see
 * "Simplified Technical English — How We Write Documentation" in AGENTS.md).
 * Run as part of `deno task precommit`, or on its own with `deno task
 * check:comment-ste`. Pass `--update` to record a count that fell. An
 * update refuses a rise.
 */

import { SOURCE_DIR } from "./check-comments/run.ts";
import {
  freshBaseline,
  readCommentFiles,
  runCommentSteCheck,
} from "./check-comments/ste-run.ts";
import { consoleOutput } from "./check-report.ts";
import { ratchetedState } from "./check-runner.ts";

const files = await readCommentFiles(SOURCE_DIR);
const baseline = await ratchetedState(
  import.meta.url,
  "./check-comments/ste-baseline.json",
  Deno.args,
  () => freshBaseline(files),
);

Deno.exit(runCommentSteCheck(files, baseline, consoleOutput));
