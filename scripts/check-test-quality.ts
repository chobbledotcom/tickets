#!/usr/bin/env -S deno run --allow-read=. --allow-env=GITHUB_ACTIONS --allow-run=git

/**
 * The test-quality gate: fail when the branch adds a weak assertion to a test
 * file it touches, compared with the merge base on `origin/main`. A
 * pre-existing weak assertion in a touched file is a warning, not a failure
 * (see "Test Quality Standards" in AGENTS.md). Run as part of `deno task
 * precommit`, or on its own with `deno task check:test-quality`.
 */

/* jscpd:ignore-start -- imports */
import { consoleOutput } from "#scripts/check-report.ts";
import { runCommand } from "#scripts/precommit/git.ts";
import { gateExit } from "./check-test-quality/run.ts";

/* jscpd:ignore-end */

Deno.exit(await gateExit(runCommand, consoleOutput, Deno.readTextFile));
