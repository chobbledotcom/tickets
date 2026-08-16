#!/usr/bin/env -S deno run --allow-read=src/locales
/**
 * Check the user-facing copy catalog against the mechanical simple-language
 * rules (see the "Simple Language" section of AGENTS.md). Run as part of
 * `deno task precommit`, or on its own with `deno task check:copy`.
 */

import { CATALOG_DIR, runCopyCheck } from "./check-copy/run.ts";
import { consoleOutput } from "./check-report.ts";

Deno.exit(runCopyCheck(CATALOG_DIR, consoleOutput));
