#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run
import { loadConfig } from "./config.ts";
import { type CurlOptions, curlJson } from "./curl.ts";
import { writeErr, writeOut } from "./io.ts";
import { parseResource, resourcePath } from "./resources.ts";

export const usage =
  "Usage: deno task cli:api <list|get|create|update|delete> <listings|attendees|modifiers> [id] [json]\n";

export const parseBody = (raw?: string): unknown =>
  raw ? JSON.parse(raw) : undefined;

export const buildRequest = (
  command: string,
  resourceRawValue: string,
  idOrBody?: string,
  maybeBody?: string,
): CurlOptions | null => {
  const resource = parseResource(resourceRawValue);
  if (command === "list") return { path: resourcePath(resource) };
  if (command === "get") return { path: resourcePath(resource, idOrBody) };
  if (command === "create") {
    return {
      body: parseBody(idOrBody),
      method: "POST",
      path: resourcePath(resource),
    };
  }
  if (command === "update") {
    return {
      body: parseBody(maybeBody),
      method: "PUT",
      path: resourcePath(resource, idOrBody),
    };
  }
  if (command === "delete") {
    return {
      body: parseBody(maybeBody),
      method: "DELETE",
      path: resourcePath(resource, idOrBody),
    };
  }
  return null;
};

export const main = async (args = Deno.args): Promise<void> => {
  const [command, resourceRaw, idOrBody, maybeBody] = args;
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
  await writeOut(
    `${JSON.stringify(await curlJson(config, request), null, 2)}\n`,
  );
};

if (import.meta.main) await main();
