import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getFormatting", "guide", "GET", "/admin/formatting"),
  route("getGuide", "guide", "GET", "/admin/guide"),
] as const;
