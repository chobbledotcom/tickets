#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run
import { buildRequest } from "./api-request.ts";
import { loadConfig } from "./config.ts";
import { curlJson } from "./curl.ts";
import { writeErr, writeOut } from "./io.ts";
import { resources } from "./resources.ts";

const [command, resourceRaw, idOrBody, maybeBody] = Deno.args;
const usage = `Usage: deno task cli:api <list|get|create|update|delete> <${resources.join("|")}> [id] [json]\n`;

if (!command || !resourceRaw) {
  await writeErr(usage);
  Deno.exit(2);
}

const request = buildRequest(command, resourceRaw, idOrBody, maybeBody);
if (!request) {
  await writeErr(usage);
  Deno.exit(2);
}

const config = await loadConfig();
await writeOut(`${JSON.stringify(await curlJson(config, request), null, 2)}\n`);
