#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { recordGuide } from "#scripts/guides/build.ts";
import { GUIDE_SLUGS } from "#scripts/guides/storyboards/index.ts";
import { guideSlugs } from "./args.ts";

const options = parseArgs(Deno.args, {
  boolean: ["allow-dirty", "keep-frames", "keep-session"],
  string: ["from"],
});
const slugs = guideSlugs(options._, GUIDE_SLUGS, options.from);

if (import.meta.main) {
  for (const slug of slugs) {
    console.log(`Recording ${slug}...`);
    const result = await recordGuide({
      allowDirty: options["allow-dirty"],
      ...(options.from ? { fromSession: options.from } : {}),
      keepFrames: options["keep-frames"],
      keepSession: options["keep-session"],
      slug,
    });
    console.log(`\nRecorded ${slug}.`);
    console.log(`  Video:    ${result.video}`);
    console.log(`  Frames:   ${result.frameCount}`);
    console.log(`  Duration: ${Math.round(result.durationMs / 1000)}s`);
    console.log(
      result.baselineWritten
        ? "  Baseline: guides/<slug>/freshness.json"
        : "  Baseline: not written (dirty worktree)",
    );
  }
}
