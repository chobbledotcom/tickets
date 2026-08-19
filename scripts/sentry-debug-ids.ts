#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Give the deployed bundle a Sentry debug id, so an uploaded source map can be
 * matched to the stack traces it explains. See `sentry-debug-ids/run.ts`.
 */

import { COMMAND_NAMES, runCommand } from "./sentry-debug-ids/run.ts";

const [command, bundlePath] = Deno.args;
if (!command || !bundlePath) {
  console.error(
    `Usage: sentry-debug-ids.ts <${COMMAND_NAMES.join("|")}> <bundle-path>`,
  );
  Deno.exit(1);
}
console.log(await runCommand(command, bundlePath));
