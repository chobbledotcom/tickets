#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env
/** Print this branch's contract drift against a base ref: which machine
 * moves, money flags, and joint-state invariants changed.
 *
 *     deno task contract:diff [base]
 *
 * `base` defaults to `origin/main`. Run `git fetch origin main` first: the
 * tool reads the ref as this checkout holds it. Drift is a report, not a
 * gate — the exit code is 0 whether or not the contracts moved. */

import { defaultDriftDeps, runContractDrift } from "./contract-drift/run.ts";

const base = Deno.args[0] ?? "origin/main";
Deno.exit(await runContractDrift(base, defaultDriftDeps()));
