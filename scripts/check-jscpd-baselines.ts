#!/usr/bin/env -S deno run -A

/**
 * The jscpd baseline ratchet: fail when this branch accepts a clone that the
 * merge base on `origin/main` does not accept, and when a scan task names a
 * baseline that the check cannot read. The baselines only shrink, so a branch
 * must never raise one. A re-paired clone is the one accepted rise, and the
 * check repeats the scan with jscpd to find it. Run as part of
 * `deno task precommit`, or on its own with `deno task check:jscpd-baselines`.
 * See "Code Duplication" in AGENTS.md.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import { baseScanner } from "./check-jscpd-baselines/base-scan.ts";
import {
  baselineFiles,
  ratchetExit,
  repositoryTasks,
  taskBaselines,
} from "./check-jscpd-baselines/ratchet-run.ts";
import { ensureJscpd } from "./jscpd/install.ts";
import { runCommand } from "./precommit/git.ts";

Deno.exit(
  await ratchetExit({
    output: consoleOutput,
    readBaselines: baselineFiles,
    readNamedBaselines: taskBaselines,
    run: runCommand,
    scanNewClones: baseScanner({
      jscpd: ensureJscpd,
      readTasks: repositoryTasks,
      run: runCommand,
    }),
  }),
);
