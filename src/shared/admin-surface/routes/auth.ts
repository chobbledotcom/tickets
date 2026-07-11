import { operation, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getLogin", "auth", "GET", "/admin/login"),
  route("getLogout", "auth", "GET", "/admin/logout"),
  operation("postLogin", "auth", "/admin/login"),
  operation("postLogout", "auth", "/admin/logout"),
] as const;
