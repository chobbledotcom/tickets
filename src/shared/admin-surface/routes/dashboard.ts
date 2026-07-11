import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getAdmin", "dashboard", "GET", "/admin"),
  route("getListings", "dashboard", "GET", "/admin/listings"),
  route("getListingsCsv", "dashboard", "GET", "/admin/listings/csv"),
  route("getLog", "dashboard", "GET", "/admin/log"),
] as const;
