#!/usr/bin/env -S deno run --allow-read=. --allow-run=git

/**
 * The jscpd baseline ratchet: fail when this branch accepts a clone that the
 * merge base on `origin/main` does not accept, and when a scan task names a
 * baseline that the check cannot read. The baselines only shrink, so a branch
 * must never raise one. Run as part of `deno task precommit`, or on its own
 * with `deno task check:jscpd-baselines`. See "Code Duplication" in AGENTS.md.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import {
  baselineFiles,
  ratchetExit,
  taskBaselines,
} from "./check-jscpd-baselines/ratchet-run.ts";
import { runCommand } from "./precommit/git.ts";

Deno.exit(
  await ratchetExit({
    output: consoleOutput,
    readBaselines: baselineFiles,
    readNamedBaselines: taskBaselines,
    run: runCommand,
  }),
);
