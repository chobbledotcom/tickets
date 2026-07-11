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
  route(
    "postLogisticsByIdEdit",
    "settingsLogistics",
    "POST",
    "/admin/logistics/:id/edit",
  ),
  route(
    "getLogisticsByIdEdit",
    "settingsLogistics",
    "GET",
    "/admin/logistics/:id/edit",
  ),
  route(
    "postLogisticsHasLogistics",
    "settingsLogistics",
    "POST",
    "/admin/logistics/has-logistics",
  ),
] as const;
