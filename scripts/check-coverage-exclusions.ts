#!/usr/bin/env -S deno run --allow-read=. --allow-sys --allow-run=git

/**
 * The coverage exclusion ratchet: fail when the branch adds an entry to
 * `scripts/check-coverage-exclusions/exclusions.ts` compared with the merge
 * base on `origin/main`. Removing an entry is always allowed. Run as part of
 * `deno task precommit`, or on its own with
 * `deno task check:coverage-exclusions`. See "Never add a coverage
 * exclusion" in AGENTS.md.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import { EXCLUSIONS_PATH } from "./check-coverage-exclusions/exclusion-ratchet.ts";
import { ratchetExit } from "./check-coverage-exclusions/ratchet-run.ts";
import { runCommand } from "./precommit/git.ts";

Deno.exit(
  await ratchetExit(
    runCommand,
    await Deno.readTextFile(EXCLUSIONS_PATH),
    consoleOutput,
  ),
);
