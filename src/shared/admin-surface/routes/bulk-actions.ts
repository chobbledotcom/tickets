import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getGroupsByIdBulkActions",
    "bulkActions",
    "GET",
    "/admin/groups/:id/bulk-actions",
  ),
  route(
    "getGroupsByIdBulkActionsDeactivate",
    "bulkActions",
    "GET",
    "/admin/groups/:id/bulk-actions/deactivate",
  ),
  route(
    "getGroupsByIdBulkActionsDuplicate",
    "bulkActions",
    "GET",
    "/admin/groups/:id/bulk-actions/duplicate",
  ),
  route(
    "getGroupsByIdBulkActionsReactivate",
    "bulkActions",
    "GET",
    "/admin/groups/:id/bulk-actions/reactivate",
  ),
  route(
    "postGroupsByIdBulkActionsDeactivate",
    "bulkActions",
    "POST",
    "/admin/groups/:id/bulk-actions/deactivate",
  ),
  route(
    "postGroupsByIdBulkActionsDuplicate",
    "bulkActions",
    "POST",
    "/admin/groups/:id/bulk-actions/duplicate",
  ),
  route(
    "postGroupsByIdBulkActionsReactivate",
    "bulkActions",
    "POST",
    "/admin/groups/:id/bulk-actions/reactivate",
  ),
] as const;
