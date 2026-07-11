import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getSessions", "sessions", "GET", "/admin/sessions"),
  route("postSessions", "sessions", "POST", "/admin/sessions"),
] as const;
