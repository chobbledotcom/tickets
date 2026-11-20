#!/usr/bin/env -S deno run -A

/**
 * The cpd counts ratchet: fail when this branch accepts more duplicated places
 * than the merge base on `origin/main`, and when a scan task names no count in
 * `cfg/cpd-counts.json`. The counts only fall, so a branch must never raise
 * one. Run as part of `deno task precommit`, or on its own with
 * `deno task check:cpd-counts`. See "Code Duplication" in AGENTS.md.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import {
  ratchetExit,
  repositoryTasks,
  workingCountsText,
} from "./check-cpd-counts/ratchet-run.ts";
import { runCommand } from "./precommit/git.ts";

Deno.exit(
  await ratchetExit({
    output: consoleOutput,
    readCountsText: workingCountsText,
    readTasks: repositoryTasks,
    run: runCommand,
  }),
);
