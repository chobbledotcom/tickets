import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getCalendar", "calendar", "GET", "/admin/calendar"),
  route("getCalendarExport", "calendar", "GET", "/admin/calendar/export"),
] as const;
