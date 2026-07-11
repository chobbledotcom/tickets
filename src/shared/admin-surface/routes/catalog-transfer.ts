import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getCatalogImport", "catalogTransfer", "GET", "/admin/catalog/import"),
  route(
    "getGroupsByIdExportJson",
    "catalogTransfer",
    "GET",
    "/admin/groups/:id/export.json",
  ),
  route(
    "getListingByIdExportJson",
    "catalogTransfer",
    "GET",
    "/admin/listing/:id/export.json",
  ),
  route(
    "postCatalogImport",
    "catalogTransfer",
    "POST",
    "/admin/catalog/import",
  ),
] as const;
