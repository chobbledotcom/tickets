import type { CurlOptions } from "./curl.ts";
import { parseResource, resourcePath, resources } from "./resources.ts";

export const apiUsage = `Usage: deno task cli:api <list|get|create|update|delete> <${resources.join(
  "|",
)}> [id] [json]\n`;

const parseBody = (raw?: string): unknown =>
  raw ? JSON.parse(raw) : undefined;

export const buildApiRequest = (
  command: string | undefined,
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
