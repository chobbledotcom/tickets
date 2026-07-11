import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getHolidaysByIdDelete",
    "holidays",
    "GET",
    "/admin/holidays/:id/delete",
  ),
  route(
    "postHolidaysByIdDelete",
    "holidays",
    "POST",
    "/admin/holidays/:id/delete",
  ),
  route("getHolidays", "holidays", "GET", "/admin/holidays"),
  route("getHolidaysNew", "holidays", "GET", "/admin/holidays/new"),
  route("postHolidays", "holidays", "POST", "/admin/holidays"),
  route("getHolidaysByIdEdit", "holidays", "GET", "/admin/holidays/:id/edit"),
  route("postHolidaysByIdEdit", "holidays", "POST", "/admin/holidays/:id/edit"),
] as const;
