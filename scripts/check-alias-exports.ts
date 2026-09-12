#!/usr/bin/env -S deno run --allow-read=src,test,scripts,cli,e2e-payments --allow-env --allow-sys --allow-ffi

/**
 * Check the source trees for alias exports — exported names that only rename
 * an imported one (see "No alias exports" in AGENTS.md). Run as part of
 * `deno task precommit`, or on its own with `deno task check:alias-exports`.
 */

import { runAliasExportCheck, SOURCE_DIRS } from "./check-alias-exports/run.ts";
import { consoleOutput } from "./check-report.ts";

Deno.exit(await runAliasExportCheck(SOURCE_DIRS, consoleOutput));
