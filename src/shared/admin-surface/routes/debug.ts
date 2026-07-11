import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getDebug", "debug", "GET", "/admin/debug"),
] as const;
