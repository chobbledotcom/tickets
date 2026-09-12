#!/usr/bin/env -S deno run --allow-read=src,test,scripts,cli,e2e-payments --allow-env --allow-sys --allow-ffi

/**
 * Check the source trees for an empty catch block (see "No empty catch" in
 * the Offensive Programming rules in AGENTS.md). Run as part of
 * `deno task precommit`, or on its own with `deno task check:empty-catch`.
 */

import { runEmptyCatchCheck, SOURCE_DIRS } from "./check-empty-catch/run.ts";
import { consoleOutput } from "./check-report.ts";

Deno.exit(await runEmptyCatchCheck(SOURCE_DIRS, consoleOutput));
