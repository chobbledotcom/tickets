/**
 * Servicing §8 — calendar, groups & feeds.
 *
 * Operator decision: servicing holds DO appear on the admin calendar (so the
 * operator can see what's blocking a day), linked to `/admin/servicing/:id`
 * and visually marked so they don't read as a customer. They do NOT leak into
 * the CalDAV/ICS syndication feed (external clients) nor the groups page's
 * attendee list.
 *
 * Implementation contract (test-first):
 *   - The admin calendar loader includes `kind='servicing'` rows (it is the one
 *     admin surface that intentionally shows them) and tags each with a
 *     `servicing` flag the template renders as a distinct marker + the
 *     kind-aware admin link from §0.
 *   - `getAttendeesByListingIds` (groups page + CalDAV feed) excludes
 *     `kind='servicing'`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { getAttendeeKindsByIds } from "#shared/db/attendees.ts";
import { getAttendeesByListingIds } from "#shared/db/listings.ts";
import {
  awaitTestRequest,
  createDailyTestListing,
  createServicingHold,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectServicingLink,
  getTestSession,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

const CALENDAR_DATE = "2026-07-01";

/** Create a daily listing + a servicing hold on the calendar date. */
const createCalendarHold = async (
  listingOverrides: Parameters<typeof createDailyTestListing>[0] = {},
) => {
  const listing = await createDailyTestListing({
    maxAttendees: 5,
    name: "Room A",
    ...listingOverrides,
  });
  const { id } = await createServicingHold({
    date: CALENDAR_DATE,
    listing: { name: "Room A", ...listingOverrides },
    name: "Boiler Service",
    quantity: 2,
  });
  return { id, listing };
};

describeWithEnv("servicing §8 — calendar, groups & feeds", { db: true }, () => {
  test("servicing events appear on the admin calendar for their date", async () => {
    await createCalendarHold();
    const body = await renderAdminPage(`/admin/calendar?date=${CALENDAR_DATE}`);
    expect(body).toContain("Boiler Service");
  });

  test("calendar links a servicing event to /admin/servicing/:id, not /admin/attendees/:id", async () => {
    const { id } = await createCalendarHold();
    const body = await renderAdminPage(`/admin/calendar?date=${CALENDAR_DATE}`);
    expectServicingLink(body, id);
  });

  test("servicing events are visually distinct on the calendar (marked, not customer-styled)", async () => {
    await createCalendarHold();
    const body = await renderAdminPage(`/admin/calendar?date=${CALENDAR_DATE}`);
    expect(body).toMatch(
      /data-servicing|class="[^"]*servicing|servicing-event/i,
    );
  });

  test("groups page attendee list excludes servicing (getAttendeesByListingIds)", async () => {
    const group = await createTestGroup({
      maxAttendees: 10,
      name: "G",
      slug: "g",
    });
    const a = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "GA",
    });
    await createServicingHold({
      listing: { groupId: group.id, name: "GA" },
      name: "Group Service",
    });
    const rows = await getAttendeesByListingIds([a.id], true);
    expect(
      rows.every((r) => (r as { kind?: string }).kind !== SERVICING_KIND),
    ).toBe(true);
    expect(rows.length).toBe(0);
  });

  test("kind lookups return an empty map for an empty attendee id list", async () => {
    expect(await getAttendeeKindsByIds([])).toEqual(new Map());
  });

  test("listing attendee lookup returns no rows for an empty listing id list", async () => {
    expect(await getAttendeesByListingIds([])).toEqual([]);
  });

  test("listing attendee lookup defaults object filters to attendee-only rows", async () => {
    const { listing } = await createServicingHold({
      date: CALENDAR_DATE,
      listing: { maxAttendees: 5, name: "Object Filter Room" },
      name: "Object Filter Service",
      quantity: 2,
    });
    expect(await getAttendeesByListingIds([listing.id], {})).toEqual([]);
  });

  test("calendar scope includes servicing rows when explicitly requested", async () => {
    const { id, listing } = await createServicingHold({
      date: CALENDAR_DATE,
      listing: { maxAttendees: 5, name: "Calendar Scope Room" },
      name: "Calendar Scope Service",
      quantity: 2,
    });
    const rows = await getAttendeesByListingIds([listing.id], {
      activeOnly: true,
      kindScope: "attendees-and-servicing",
    });
    expect(rows.map((row) => row.id)).toEqual([id]);
    expect(rows[0]!.quantity).toBe(2);
  });

  test("CalDAV feed excludes servicing events (no servicing VEVENT leaks)", async () => {
    await createCalendarHold();
    const { settings } = await import("#shared/db/settings.ts");
    settings.setForTest({ calendar_feeds_enabled: true });
    try {
      const { cookie } = await getTestSession();
      const body = await (
        await awaitTestRequest("/caldav/events.ics", { cookie })
      ).text();
      expect(body).toContain("BEGIN:VCALENDAR");
      expect(body).not.toContain("Boiler Service");
      expect(body).not.toContain("SUMMARY:Boiler Service");
    } finally {
      settings.clearTestOverride("calendar_feeds_enabled");
    }
  });
});
