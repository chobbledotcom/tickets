import { constantTimeEqual } from "#crypto/utils.ts";
import { bearerTokenOrNull } from "#shared/bearer.ts";
import { getEnv } from "#shared/env.ts";
import { normalizePath } from "#shared/path.ts";
import { SCHEDULED_TASK_KEY_ENV } from "#shared/scheduled-keys.ts";

export const SCHEDULED_PATH = "/scheduled";

export type ScheduledAccess =
  | { kind: "not_scheduled" }
  | { kind: "authorized" }
  | { kind: "rejected"; status: 401 | 404 };

export const checkScheduledAccess = (
  request: Pick<Request, "method" | "url" | "headers">,
  key: string | undefined,
): ScheduledAccess => {
  if (normalizePath(new URL(request.url).pathname) !== SCHEDULED_PATH) {
    return { kind: "not_scheduled" };
  }
  if (request.method !== "POST" || key === undefined) {
    return { kind: "rejected", status: 404 };
  }
  const supplied = bearerTokenOrNull(request.headers.get("authorization"));
  if (supplied === null) return { kind: "rejected", status: 401 };
  return constantTimeEqual(supplied, key)
    ? { kind: "authorized" }
    : { kind: "rejected", status: 401 };
};

export const scheduledAccessFromEnv = (request: Request): ScheduledAccess =>
  checkScheduledAccess(request, getEnv(SCHEDULED_TASK_KEY_ENV));

export const scheduledResponse = (status: 204 | 401 | 404 | 503): Response =>
  new Response(null, {
    headers: {
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
    status,
  });
