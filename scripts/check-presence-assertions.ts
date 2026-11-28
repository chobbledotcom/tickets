#!/usr/bin/env -S deno run --allow-read=test,scripts

/**
 * Check the test tree for `toBeDefined()` (see "Test Quality Standards" in
 * AGENTS.md). Run as part of `deno task precommit`, or on its own with
 * `deno task check:presence-assertions`.
 */

import { runPresenceCheck } from "./check-presence-assertions/run.ts";
import { consoleOutput } from "./check-report.ts";

Deno.exit(await runPresenceCheck(["test"], consoleOutput));
