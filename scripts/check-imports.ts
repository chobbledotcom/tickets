#!/usr/bin/env -S deno run --allow-read

/**
 * Check that every import names its module one way: once per file, and by the
 * shortest alias the import map gives it (see "Imports name a module one way"
 * in AGENTS.md). Run as part of `deno task precommit`, or on its own with
 * `deno task check:imports`.
 */

import {
  CONFIG_PATH,
  runImportCheck,
  SOURCE_DIRS,
} from "./check-imports/run.ts";
import { consoleOutput } from "./check-report.ts";

Deno.exit(await runImportCheck(CONFIG_PATH, SOURCE_DIRS, consoleOutput));
