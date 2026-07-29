#!/usr/bin/env -S deno run --allow-all
import { runEvidenceSpecs } from "./specs/evidence/run.ts";
import { EVIDENCE_THEMES_ENV } from "./specs/evidence/themes.ts";
import { withTestHarness } from "./test-harness.ts";

/**
 * `--themes <dir>` dresses each capture in the CSS whoever publishes the
 * screenshots keeps for it. Without it the captures are taken in the app's own
 * default look, which is what this repo's CI wants: it is checking that the
 * pages can be captured, not what they look like on somebody's marketing site.
 */
const themesDirectory = (args: readonly string[]): string | undefined => {
  const at = args.indexOf("--themes");
  if (at === -1) return;
  const directory = args[at + 1];
  if (!directory) throw new Error("--themes needs a directory");
  return directory;
};

if (import.meta.main) {
  const directory = themesDirectory(Deno.args);
  if (directory) Deno.env.set(EVIDENCE_THEMES_ENV, directory);
  const result = await withTestHarness(runEvidenceSpecs);
  Deno.exit(result.success ? 0 : 1);
}
