import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getUpdate", "update", "GET", "/admin/update"),
  route("postUpdate", "update", "POST", "/admin/update"),
  route("postUpdateCheck", "update", "POST", "/admin/update/check"),
] as const;
