import type { AdminApiRequest } from "#shared/admin-api-client.ts";
import { parseResource, resourcePath } from "./resources.ts";

/** Parse an optional JSON body argument; an absent/empty value means no body. */
export const parseBody = (raw?: string): unknown =>
  raw ? JSON.parse(raw) : undefined;

/**
 * Build the curl request for a CLI command, or null when the command is not a
 * recognised verb. Pure over its arguments (the entrypoint passes the parsed
 * `Deno.args`) so the request-building logic can be unit-tested in-process
 * without running the CLI.
 *
 * A nested create addresses the parent collection with a path suffix:
 * `create attributes 3/options '{"text":"…"}'` posts to
 * `/api/admin/attributes/3/options`. When both arguments after the resource
 * are present, the first is that path suffix and the second the JSON body;
 * with one argument it is the JSON body, as before.
 */
export const buildRequest = (
  command: string,
  resourceRawValue: string,
  idOrBody?: string,
  maybeBody?: string,
): AdminApiRequest | null => {
  const resource = parseResource(resourceRawValue);
  if (command === "list") {
    return { method: "GET", path: resourcePath(resource) };
  }
  if (command === "get") {
    return { method: "GET", path: resourcePath(resource, idOrBody) };
  }
  if (command === "create") {
    const nested = idOrBody !== undefined && maybeBody !== undefined;
    return {
      body: parseBody(nested ? maybeBody : idOrBody),
      method: "POST",
      path: resourcePath(resource, nested ? idOrBody : undefined),
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
