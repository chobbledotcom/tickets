#!/usr/bin/env -S deno run --allow-read=src/locales
/**
 * Check the user-facing copy catalog against the mechanical simple-language
 * rules (see the "Simple Language" section of AGENTS.md). Run as part of
 * `deno task precommit`, or on its own with `deno task check:copy`.
 */

import { runCopyCheck } from "./check-copy/run.ts";

Deno.exit(runCopyCheck("src/locales/en", console.log, console.error));
