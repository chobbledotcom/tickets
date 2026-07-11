import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getPrivacy", "privacy", "GET", "/admin/privacy"),
  route("postPrivacyErase", "privacy", "POST", "/admin/privacy/erase"),
  route("postPrivacyOrphans", "privacy", "POST", "/admin/privacy/orphans"),
] as const;
