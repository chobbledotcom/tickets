#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run
import { apiUsage, buildApiRequest } from "./api-request.ts";
import { loadConfig } from "./config.ts";
import { curlJson } from "./curl.ts";
import { writeErr, writeOut } from "./io.ts";

const [command, resourceRaw, idOrBody, maybeBody] = Deno.args;
if (!command || !resourceRaw) {
  await writeErr(apiUsage);
  Deno.exit(2);
}

const request = buildApiRequest(command, resourceRaw, idOrBody, maybeBody);
if (!request) {
  await writeErr(apiUsage);
  Deno.exit(2);
}

const config = await loadConfig();
await writeOut(`${JSON.stringify(await curlJson(config, request), null, 2)}\n`);
