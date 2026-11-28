#!/usr/bin/env -S deno run --allow-all
import { runGuideEvidenceSpecs } from "./guides/evidence-run.ts";
import { withTestHarness } from "./test-harness.ts";

if (import.meta.main) {
  const result = await withTestHarness(runGuideEvidenceSpecs);
  Deno.exit(result.success ? 0 : 1);
}
