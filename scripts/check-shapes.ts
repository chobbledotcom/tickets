#!/usr/bin/env -S deno run -A

/**
 * Check for functions that do the same thing under different names. jscpd
 * compares tokens as written, so a renamed copy passes it; this compares the
 * shape instead. Run as part of `deno task precommit`, or on its own with
 * `deno task check:shapes`.
 */

import { consoleOutput } from "./check-report.ts";
import {
  ACCEPTED_DIR,
  runShapeCheck,
  SOURCE_DIRS,
} from "./check-shapes/run.ts";

Deno.exit(await runShapeCheck(SOURCE_DIRS, ACCEPTED_DIR, consoleOutput));
