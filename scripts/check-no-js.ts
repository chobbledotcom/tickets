#!/usr/bin/env -S deno run --allow-run=git

/**
 * Check that the repository tracks no JavaScript file (see "Runtime
 * Environment" in AGENTS.md). Run as part of `deno task precommit`, or on its
 * own with `deno task check:no-js`.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import { runNoJsCheck } from "./check-no-js/run.ts";
import { runCommand } from "./precommit/git.ts";

Deno.exit(await runNoJsCheck(runCommand, consoleOutput));
