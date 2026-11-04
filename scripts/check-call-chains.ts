#!/usr/bin/env -S deno run --allow-read=src --allow-env --allow-sys --allow-ffi

/**
 * Find the chains of three or more methods that repeat at two or more sites in
 * `src/` (see "Keep methods flat" in AGENTS.md). Nothing is accepted: each one
 * asks for one helper. Run as part of `deno task precommit`, or on its own with
 * `deno task check:call-chains`.
 */

import { runCallChainCheck } from "./check-call-chains/run.ts";
import { consoleOutput } from "./check-report.ts";

/** The tree the check reads. */
const ROOTS = ["src"];

Deno.exit(await runCallChainCheck(ROOTS, consoleOutput));
