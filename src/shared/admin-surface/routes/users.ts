import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getUsersByIdDelete", "users", "GET", "/admin/users/:id/delete"),
  route("postUsersByIdDelete", "users", "POST", "/admin/users/:id/delete"),
  route("getUserNew", "users", "GET", "/admin/user/new"),
  route("getUsers", "users", "GET", "/admin/users"),
  route("getUsersById", "users", "GET", "/admin/users/:id"),
  route("getUsersByIdAgents", "users", "GET", "/admin/users/:id/agents"),
  route("postUsers", "users", "POST", "/admin/users"),
  route("postUsersByIdAgents", "users", "POST", "/admin/users/:id/agents"),
] as const;
