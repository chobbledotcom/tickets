#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { recordGuide } from "./guides/record-guide.ts";
import { GUIDE_SLUGS } from "./guides/storyboards/index.ts";

const options = parseArgs(Deno.args, {
  boolean: ["allow-dirty", "keep-frames", "keep-session"],
  string: ["from"],
});
const requested = options._.map(String);
const slugs =
  requested.length === 0 || requested[0] === "all" ? GUIDE_SLUGS : requested;
if (options.from && slugs.length !== 1) {
  throw new Error("--from takes exactly one guide");
}

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
