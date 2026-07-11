import { operation, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getSupport", "support", "GET", "/admin/support"),
  operation("postSupport", "support", "/admin/support"),
] as const;
