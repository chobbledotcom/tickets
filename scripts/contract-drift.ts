#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env
/** Print this branch's contract drift against a base ref: which machine
 * moves, money flags, and joint-state invariants changed.
 *
 *     deno task contract:diff [base]
 *
 * `base` defaults to the commit this branch and origin/main share. The
 * tool fetches the history that commit needs when the checkout lacks it.
 * An explicit `base` is read as this checkout holds it, so run `git fetch
 * origin main` first for a current base. Drift is a report, not a gate —
 * the exit code is 0 whether or not the contracts moved. */

import { defaultDriftDeps, runContractDrift } from "./contract-drift/run.ts";

const deps = defaultDriftDeps();
const base = Deno.args[0] ?? (await deps.mergeBase());
Deno.exit(await runContractDrift(base, deps));
