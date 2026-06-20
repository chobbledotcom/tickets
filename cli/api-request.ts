import type { CurlOptions } from "./curl.ts";
import { parseResource, resourcePath } from "./resources.ts";

/** Parse an optional JSON body argument; an absent/empty value means no body. */
export const parseBody = (raw?: string): unknown =>
  raw ? JSON.parse(raw) : undefined;

/**
 * Build the curl request for a CLI command, or null when the command is not a
 * recognised verb. Pure over its arguments (the entrypoint passes the parsed
 * `Deno.args`) so the request-building logic can be unit-tested in-process
 * without running the CLI.
 */
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
