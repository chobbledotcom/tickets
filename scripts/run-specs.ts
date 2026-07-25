#!/usr/bin/env -S deno run --allow-all
import { parseSpecArgs } from "./specs/options.ts";
import { runSpecs } from "./specs/run.ts";
import { withTestHarness } from "./test-harness.ts";

if (import.meta.main) {
  const parsed = parseSpecArgs(Deno.args);
  const result = await withTestHarness(() =>
    runSpecs({
      ...(parsed.paths.length === 0 ? {} : { paths: parsed.paths }),
      ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
    }),
  );
  Deno.exit(result.success ? 0 : 1);
}
