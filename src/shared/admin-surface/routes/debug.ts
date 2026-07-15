import { operation, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getDebug", "debug", "GET", "/admin/debug"),
  operation("postSentryTest", "debug", "/admin/debug/sentry"),
] as const;
