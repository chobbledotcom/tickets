import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getBuilder", "builder", "GET", "/admin/builder"),
  route("postBuilder", "builder", "POST", "/admin/builder"),
] as const;
