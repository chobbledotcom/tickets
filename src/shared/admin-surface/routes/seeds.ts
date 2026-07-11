import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getSeeds", "seeds", "GET", "/admin/seeds"),
  route("postSeeds", "seeds", "POST", "/admin/seeds"),
] as const;
