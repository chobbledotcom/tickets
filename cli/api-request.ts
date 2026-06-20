/**
 * Pure request-planning for the api CLI.
 *
 * No I/O, no process exit, no network — just a transform from the raw
 * positional arguments to either a curl request or a usage error. Keeping it
 * side-effect free is what makes it unit-testable in-process (and so its
 * coverage is deterministic); the thin `cli/api.ts` shell does the actual
 * reading, writing and exiting.
 */

import type { CurlOptions } from "./curl.ts";
import { parseResource, resourcePath, resources } from "./resources.ts";

const usage = `Usage: deno task cli:api <list|get|create|update|delete> <${resources.join("|")}> [id] [json]\n`;

/** Parse an optional JSON request body, undefined when none was supplied. */
const parseBody = (raw?: string): unknown =>
  raw ? JSON.parse(raw) : undefined;

/** Translate the verb + positional args into a curl request, or null when the
 * command verb is not recognised. */
const buildRequest = (
  command: string,
  resourceRaw: string,
  idOrBody?: string,
  maybeBody?: string,
): CurlOptions | null => {
  const resource = parseResource(resourceRaw);
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

/** Either a ready-to-send request or the usage text to print on stderr. */
export type ApiPlan = { request: CurlOptions } | { usageError: string };

/**
 * Plan an api CLI invocation from its raw argument list. Missing a verb or
 * resource, or an unknown verb, yields a usage error rather than a request.
 */
export const planApiCall = (args: string[]): ApiPlan => {
  const [command, resourceRaw, idOrBody, maybeBody] = args;
  if (!command || !resourceRaw) return { usageError: usage };
  const request = buildRequest(command, resourceRaw, idOrBody, maybeBody);
  return request ? { request } : { usageError: usage };
};
