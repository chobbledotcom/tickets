import { constantTimeEqual } from "#shared/crypto/utils.ts";
import { getEnv } from "#shared/env.ts";
import {
  SCHEDULED_TASK_KEY_ENV,
  SCHEDULED_TASK_KEY_NEXT_ENV,
} from "#shared/scheduled-keys.ts";

export const SCHEDULED_PATH = "/scheduled";

export type ScheduledAccess =
  | { kind: "not_scheduled" }
  | { kind: "authorized" }
  | { kind: "rejected"; status: 401 | 404 };

const bearerValue = (authorization: string | null): string | null => {
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
};

export const checkScheduledAccess = (
  request: Pick<Request, "method" | "url" | "headers">,
  active: string | undefined,
  next: string | undefined,
): ScheduledAccess => {
  if (new URL(request.url).pathname !== SCHEDULED_PATH) {
    return { kind: "not_scheduled" };
  }
  if (request.method !== "POST" || active === undefined) {
    return { kind: "rejected", status: 404 };
  }
  const supplied = bearerValue(request.headers.get("authorization"));
  if (supplied === null) return { kind: "rejected", status: 401 };
  const activeMatches = constantTimeEqual(supplied, active);
  const nextMatches = constantTimeEqual(supplied, next ?? "");
  return activeMatches || nextMatches
    ? { kind: "authorized" }
    : { kind: "rejected", status: 401 };
};

export const scheduledAccessFromEnv = (request: Request): ScheduledAccess =>
  checkScheduledAccess(
    request,
    getEnv(SCHEDULED_TASK_KEY_ENV),
    getEnv(SCHEDULED_TASK_KEY_NEXT_ENV),
  );

export const scheduledResponse = (status: 204 | 401 | 404 | 503): Response =>
  new Response(null, {
    headers: {
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
    status,
  });
