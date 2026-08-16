#!/usr/bin/env -S deno run --allow-read=src

/**
 * Check source comments against the length and width limits (see "Comments are
 * short" in AGENTS.md). Run as part of `deno task precommit`, or on its own
 * with `deno task check:comments`.
 */

import { LIMITS, runCommentCheck, SOURCE_DIR } from "./check-comments/run.ts";
import { consoleOutput } from "./check-report.ts";

Deno.exit(await runCommentCheck(SOURCE_DIR, LIMITS, consoleOutput));
