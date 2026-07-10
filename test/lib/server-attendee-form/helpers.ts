import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

type AttendeeRow = Awaited<ReturnType<typeof getAttendeesRaw>>[number];

/** Submit the unified new-attendee admin form, injecting a fresh CSRF token. */
export const submitNewAttendeeForm = async (
  fields: Record<string, string>,
): Promise<Response> => {
  const { cookie, csrfToken } = await getTestSession();
  return handleRequest(
    mockFormRequest(
      "/admin/attendees/new",
      { csrf_token: csrfToken, ...fields },
      cookie,
    ),
  );
};

/** Assert a listing has exactly `count` attendee rows and return them. */
export const expectAttendeeLineCount = async (
  listingId: number,
  count: number,
): Promise<AttendeeRow[]> => {
  const rows = await getAttendeesRaw(listingId);
  expect(rows.length).toBe(count);
  return rows;
};

/**
 * Assert a 302 and the one-standard-line (undated) + one-daily-line (on `date`)
 * shape shared by the mixed single/multi-day integration tests; returns the
 * daily rows for any further per-test checks.
 */
export const expectMixedStandardAndDailyLines = async (
  response: Response,
  standardId: number,
  dailyId: number,
  date: string,
): Promise<AttendeeRow[]> => {
  expect(response.status).toBe(302);
  const stdAttendees = await expectAttendeeLineCount(standardId, 1);
  expect(stdAttendees[0]!.date).toBeNull();
  const dailyAttendees = await expectAttendeeLineCount(dailyId, 1);
  expect(dailyAttendees[0]!.date).toBe(date);
  return dailyAttendees;
};

const everyDay = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** A one-day daily listing bookable every day of the week. */
export const everydayDailyListing = (
  overrides: Parameters<typeof createTestListing>[0] = {},
) =>
  createTestListing({
    bookableDays: everyDay,
    durationDays: 1,
    listingType: "daily",
    maxAttendees: 50,
    ...overrides,
  });

/** Tomorrow's date in the configured timezone (the standard bookable day). */
export const tomorrowInTz = (): string =>
  addDays(todayInTz(settings.timezone), 1);

/** A listing + attendee whose booking rows have been deleted (an orphan). */
export const attendeeWithNoBookings = async (name: string) => {
  const event = await createTestListing({ maxAttendees: 100 });
  const attendee = await createTestAttendee(
    event.id,
    event.slug,
    name,
    `${name.toLowerCase()}@example.com`,
  );
  await getDb().execute("DELETE FROM listing_attendees WHERE attendee_id = ?", [
    attendee.id,
  ]);
  return attendee;
};
