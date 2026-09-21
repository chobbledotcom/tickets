#!/usr/bin/env -S deno run -A
/** Cycle gate over the production module graph, run by `deno task cycles`. */

import { runCycleGate } from "./cycles/run.ts";

const { exitCode, text } = await runCycleGate();
console.log(text);
if (exitCode !== 0) {
  console.error(
    "Break each group: home the shared core in a module both ends already" +
      "\nread, or defer one edge behind a dynamic import. The groups above" +
      "\nname every member; each member's load-time imports list its edges.",
  );
  Deno.exit(exitCode);
}
