#!/usr/bin/env -S deno run --allow-read=src,test,scripts,cli,e2e-payments,.opencode/plugins --allow-env --allow-sys --allow-ffi

/**
 * Check the source trees for an empty catch (see "No empty catch" in
 * the Offensive Programming rules in AGENTS.md). Run as part of
 * `deno task precommit`, or on its own with `deno task check:empty-catch`.
 */

import { SOURCE_DIRS } from "#scripts/source-dirs.ts";
import { runEmptyCatchCheck } from "./check-empty-catch/run.ts";
import { consoleOutput } from "./check-report.ts";

Deno.exit(await runEmptyCatchCheck(SOURCE_DIRS, consoleOutput));
