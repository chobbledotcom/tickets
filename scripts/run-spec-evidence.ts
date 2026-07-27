#!/usr/bin/env -S deno run --allow-all
import { runEvidenceSpecs } from "./specs/evidence/run.ts";
import { withTestHarness } from "./test-harness.ts";

if (import.meta.main) {
  const result = await withTestHarness(runEvidenceSpecs);
  Deno.exit(result.success ? 0 : 1);
}
