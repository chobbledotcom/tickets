import type { AgentFilter } from "#shared/logistics-filter.ts";
import type { AvailabilityRow } from "#templates/admin/availability-checker.tsx";
import {
  adminCalendarPage,
  type CalendarAttendeeRow,
} from "#templates/admin/calendar.tsx";
import type { DatePickerDate } from "#templates/date-picker.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testAttendee } from "#test-utils/factories.ts";
import type { LogisticsAgent } from "#types";

export const calendarAttendee = (
  overrides: Partial<CalendarAttendeeRow> = {},
): CalendarAttendeeRow => ({
  ...testAttendee(),
  date: "2026-03-15",
  listingDate: "",
  listingId: 1,
  listingLocation: "",
  listingName: "Daily Listing",
  ...overrides,
});

export const calendarDate = (
  label: string,
  value: string,
  selectable = true,
): DatePickerDate => ({ label, selectable, value });

export const calendarHtml = (
  overrides: {
    attendees?: CalendarAttendeeRow[];
    dateFilter?: string | null;
    availableDates?: DatePickerDate[];
    today?: string;
    viewMonth?: string | null;
    availabilityRows?: AvailabilityRow[];
    agents?: LogisticsAgent[];
    agentFilter?: AgentFilter;
  } = {},
): string =>
  adminCalendarPage(
    overrides.attendees ?? [],
    "localhost",
    OWNER_SESSION,
    overrides.dateFilter ?? null,
    overrides.availableDates ?? [],
    overrides.today ?? "2026-03-10",
    overrides.viewMonth ?? null,
    undefined,
    undefined,
    false,
    overrides.availabilityRows ?? [],
    overrides.agents ?? [],
    overrides.agentFilter ?? "all",
  );
