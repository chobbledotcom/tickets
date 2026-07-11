import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getServicing", "servicing", "GET", "/admin/servicing"),
  route("getServicingById", "servicing", "GET", "/admin/servicing/:id"),
  route("getServicingNew", "servicing", "GET", "/admin/servicing/new"),
  route("postServicingById", "servicing", "POST", "/admin/servicing/:id"),
  route(
    "postServicingByIdCostByCostId",
    "servicing",
    "POST",
    "/admin/servicing/:id/cost/:costId",
  ),
  route(
    "postServicingByIdDelete",
    "servicing",
    "POST",
    "/admin/servicing/:id/delete",
  ),
  route(
    "postServicingByIdDuplicate",
    "servicing",
    "POST",
    "/admin/servicing/:id/duplicate",
  ),
  route("postServicingNew", "servicing", "POST", "/admin/servicing/new"),
] as const;
