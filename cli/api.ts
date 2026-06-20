#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run
// Thin I/O shell: read args, plan the call (pure, in cli/api-request.ts), then
// do the only side effects — write output, or write usage and exit. Excluded
// from coverage enforcement (see COVERAGE_EXCLUSIONS); the e2e run smoke-tests
// it and api-request.ts carries the testable logic.
import { planApiCall } from "./api-request.ts";
import { loadConfig } from "./config.ts";
import { curlJson } from "./curl.ts";
import { writeErr, writeOut } from "./io.ts";

const plan = planApiCall(Deno.args);
if ("usageError" in plan) {
  await writeErr(plan.usageError);
  Deno.exit(2);
}

const config = await loadConfig();
await writeOut(
  `${JSON.stringify(await curlJson(config, plan.request), null, 2)}\n`,
);
