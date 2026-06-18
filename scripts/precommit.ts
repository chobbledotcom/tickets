#!/usr/bin/env -S deno run --allow-all
/**
 * Quiet precommit runner - shows only pass/fail per step, full output on failure.
 */

import { main } from "./precommit/runner.ts";

if (import.meta.main) await main();
