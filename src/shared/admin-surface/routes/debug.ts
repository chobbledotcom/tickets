import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getDebug", "debug", "GET", "/admin/debug"),
  route("postSentryTest", "debug", "POST", "/admin/debug/sentry"),
] as const;
