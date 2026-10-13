#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run
import type { AdminApiTransport } from "#shared/admin-api-client.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { type CliConfig, loadConfig } from "./config.ts";
import { curlTransport } from "./curl.ts";
import { readStdin, writeErr, writeOut } from "./io.ts";
import { runApi } from "./run.ts";

/** One CLI run: one JSON document on stdout, or the contract's JSON error
 *  on stderr with its exit code. */
const main = async (): Promise<number> => {
  // One config load per run: the runner fails fast on a missing site or
  // key, and the transport reuses the same load. The transport resolves
  // that load inside the runner's call, so `describe` needs no config and
  // a config failure keeps the runner's error envelope.
  let cached: Promise<CliConfig> | undefined;
  const config = (): Promise<CliConfig> => (cached ??= loadConfig(Deno.cwd()));
  const transport: AdminApiTransport = async (options) =>
    curlTransport(await config())(options);
  const result = await runApi(Deno.args, {
    config,
    readStdin,
    table: ADMIN_API_RESOURCES,
    transport,
  });
  if (result.out !== undefined) await writeOut(result.out);
  if (result.err !== undefined) await writeErr(result.err);
  return result.code;
};

if (import.meta.main) {
  Deno.exit(await main());
}
