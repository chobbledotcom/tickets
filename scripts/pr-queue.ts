#!/usr/bin/env -S deno run --allow-run=gh

/**
 * PR queue report — scans every open pull request on this repo and prints a
 * plain-language status for each (merge conflicts, behind main, whose review
 * comments are still open, whether CI is passing), grouped by who has the next
 * move.
 *
 * Everything happens in {@link ./pr-queue/run.ts}; this file only hands it the
 * arguments and turns its answer into an exit code.
 *
 * Usage (via `deno task pr-queue`, which scopes permissions to `--allow-run=gh`):
 *   deno task pr-queue            # grouped, plain-language report
 *   deno task pr-queue -- --json  # structured summaries as JSON
 *   deno task pr-queue -- --repo owner/name   # inspect another repo
 */

import { runPrQueue } from "./pr-queue/run.ts";

Deno.exit(await runPrQueue(Deno.args));
