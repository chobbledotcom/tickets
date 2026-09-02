#!/usr/bin/env -S deno run --env-file --allow-env --allow-net

/**
 * Print Bugsink issue details as JSON, so an LLM can dig into a live error.
 * See `bugs-lib.ts`.
 */

import { runBugsCli } from "#scripts/bugs-lib.ts";
import { runDenoScript } from "#scripts/script-runner.ts";

await runDenoScript(runBugsCli);
