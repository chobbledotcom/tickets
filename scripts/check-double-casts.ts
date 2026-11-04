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

import { countsCheckExit } from "#scripts/check-runner.ts";
import { SOURCE_DIRS } from "#scripts/source-dirs.ts";
import {
  filesWithDoubleCasts,
  runDoubleCastsCheck,
} from "./check-double-casts/run.ts";

Deno.exit(
  await countsCheckExit(
    import.meta.url,
    "./check-double-casts/baseline.json",
    Deno.args,
    SOURCE_DIRS,
    filesWithDoubleCasts,
    runDoubleCastsCheck,
  ),
);
