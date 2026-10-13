#!/usr/bin/env -S deno run --allow-run=git,deno --allow-read --allow-write --allow-env

/**
 * Trial-merge a head into a base and run typecheck and the test suite on the
 * merged tree, inside a throwaway worktree.
 *
 *     deno task check:merged-tree <pr-number | branch> [base]
 *
 * A numeric argument names a pull request, which merges into main. A branch
 * argument pairs with an optional base branch on origin, main by default. The
 * tool fetches, merges, checks, and removes the worktree. The checkout keeps
 * no state.
 *
 * Part of the boss's readiness bar for a pull request: the head CI passes,
 * and this check passes at the base, before the request is presented ready.
 *
 * Exit codes: 0 pass, 1 the head does not merge cleanly, 2 a merged-tree task
 * fails, 3 the inputs name no refs on origin.
 */

import { parseArgs } from "./check-merged-tree/args.ts";
import { defaultDeps, runMergedTreeCheck } from "./check-merged-tree/run.ts";

const parsed = parseArgs(Deno.args);
if (parsed.kind === "usage") {
  console.error(parsed.message);
  Deno.exit(3);
}
Deno.exit(await runMergedTreeCheck(parsed.parsed, defaultDeps()));
