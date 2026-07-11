import { operation, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getListingByIdScanner",
    "scanner",
    "GET",
    "/admin/listing/:id/scanner",
  ),
  operation("postListingByIdScan", "scanner", "/admin/listing/:id/scan"),
] as const;
