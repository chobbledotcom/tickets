import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getLogisticsByIdDelete",
    "settingsLogistics",
    "GET",
    "/admin/logistics/:id/delete",
  ),
  route(
    "postLogisticsByIdDelete",
    "settingsLogistics",
    "POST",
    "/admin/logistics/:id/delete",
  ),
  route("getLogistics", "settingsLogistics", "GET", "/admin/logistics"),
  route("getLogisticsNew", "settingsLogistics", "GET", "/admin/logistics/new"),
  route("postLogistics", "settingsLogistics", "POST", "/admin/logistics"),
  route("getLogisticsById", "settingsLogistics", "GET", "/admin/logistics/:id"),
  route(
    "getLogisticsByIdByTab",
    "settingsLogistics",
    "GET",
    "/admin/logistics/:id/:tab",
  ),
  route(
    "postLogisticsByIdEdit",
    "settingsLogistics",
    "POST",
    "/admin/logistics/:id/edit",
  ),
] as const;
