/**
 * The attendee Logistics tab: rendering (address form, pin inputs, map),
 * saving (address + pin into the PII blob, selectors onto booking rows),
 * validation failures re-rendering in place, and the Other Attendees list.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  endTimeField,
  startAgentField,
  startTimeField,
} from "#routes/admin/attendee-logistics.ts";
import { bookedSpan } from "#routes/admin/attendee-logistics-tab.ts";
import type { LoadedAttendee } from "#routes/admin/attendee-page-data.ts";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { createAttendeeAtomic, getAttendee } from "#shared/db/attendees.ts";
import { listingsTable } from "#shared/db/listings.ts";
import {
  getLogisticsAssignments,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { logisticsAgentsTable } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import {
  awaitTestRequest,
  createDailyTestListing,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
  getTestSession,
} from "#test-utils";
import { mockFormRequest } from "#test-utils/mocks.ts";

/** Create an attendee with the given bookings, returning their id. */
const makeAttendee = async (
  name: string,
  bookings: ListingBooking[],
): Promise<number> => {
  const result = await createAttendeeAtomic({ bookings, email: "", name });
  if (!result.success) throw new Error("test attendee creation failed");
  return result.attendees[0]!.id;
};

/** GET an attendee's Logistics tab HTML as the admin. */
const logisticsTabHtml = async (attendeeId: number): Promise<string> => {
  const { cookie } = await getTestSession();
  const response = await awaitTestRequest(
    `/admin/attendees/${attendeeId}/logistics`,
    { cookie },
  );
  expect(response.status).toBe(200);
  return response.text();
};

/** POST the Logistics tab form (session + CSRF handled). */
const postLogistics = async (
  attendeeId: number,
  fields: Record<string, string>,
): Promise<Response> => {
  const { cookie, csrfToken } = await getTestSession();
  return handleRequest(
    mockFormRequest(
      `/admin/attendees/${attendeeId}/logistics`,
      { csrf_token: csrfToken, ...fields },
      cookie,
    ),
  );
};

describeWithEnv("attendee Logistics tab (GET)", { db: true }, () => {
  test("renders the address form, pin inputs, and a hidden map when unpinned", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Tab Person", [{ listingId: listing.id }]);
    const html = await logisticsTabHtml(id);
    expect(html).toContain('name="address"');
    expect(html).toContain('name="lat"');
    expect(html).toContain('name="lng"');
    expect(html).toContain("data-logistics-map hidden");
    expect(html).toContain("data-address-diff");
  });

  test("the tab strip links to the Logistics tab", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Strip Person", [{ listingId: listing.id }]);
    const html = await logisticsTabHtml(id);
    expect(html).toContain(`/admin/attendees/${id}/logistics`);
    expect(html).toContain(">Logistics<");
  });

  test("404s for an unknown attendee", async () => {
    const { cookie } = await getTestSession();
    const response = await awaitTestRequest(
      "/admin/attendees/999999/logistics",
      { cookie },
    );
    expect(response.status).toBe(404);
  });
});

describeWithEnv("attendee Logistics tab (POST)", { db: true }, () => {
  test("saves the address and pin, preserving the rest of the PII blob", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "pin@example.com",
      name: "Pin Person",
    });
    if (!result.success) throw new Error("creation failed");
    const created = result.attendees[0]!;

    const response = await postLogistics(created.id, {
      address: "10 Downing Street, LONDON, SW1A 2AA",
      lat: "51.503396",
      lng: "-0.127640",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      `/admin/attendees/${created.id}/logistics`,
    );

    const saved = (await getAttendee(created.id, await getTestPrivateKey()))!;
    expect(saved.address).toBe("10 Downing Street, LONDON, SW1A 2AA");
    expect(saved.lat).toBe("51.503396");
    expect(saved.lng).toBe("-0.127640");
    expect(saved.name).toBe("Pin Person");
    expect(saved.email).toBe("pin@example.com");
    expect(saved.ticket_token).toBe(created.ticket_token);
  });

  test("a pinned attendee renders the pin values and a visible map", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Visible Map", [{ listingId: listing.id }]);
    await postLogistics(id, { address: "Somewhere", lat: "51.5", lng: "-0.1" });

    const html = await logisticsTabHtml(id);
    expect(html).toContain('value="51.5"');
    expect(html).toContain('value="-0.1"');
    expect(html).not.toContain("data-logistics-map hidden");
    expect(html).toContain("data-logistics-map");
  });

  test("blank coordinates clear the pin", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Unpin", [{ listingId: listing.id }]);
    await postLogistics(id, { address: "Somewhere", lat: "51.5", lng: "-0.1" });

    await postLogistics(id, { address: "Somewhere", lat: "", lng: "" });

    const saved = (await getAttendee(id, await getTestPrivateKey()))!;
    expect(saved.lat).toBe("");
    expect(saved.lng).toBe("");
  });

  test("an invalid pair re-renders at 400 with the error and saves nothing", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Bad Pin", [{ listingId: listing.id }]);

    const response = await postLogistics(id, {
      address: "New Address",
      lat: "91",
      lng: "0",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    // The submitted values survive the re-render; the stored blob does not change.
    expect(html).toContain("New Address");
    expect(html).toContain('value="91"');
    expect(html).toContain("leave both empty");
    const saved = (await getAttendee(id, await getTestPrivateKey()))!;
    expect(saved.address).toBe("");
    expect(saved.lat).toBe("");
  });

  test("an over-long address re-renders at 400 with the address error", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Long Address", [{ listingId: listing.id }]);

    const response = await postLogistics(id, {
      address: "x".repeat(251),
      lat: "",
      lng: "",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("250");
  });

  test("404s for an unknown attendee", async () => {
    await createTestListing({ maxAttendees: 10 });
    const response = await postLogistics(999999, { address: "" });
    expect(response.status).toBe(404);
  });

  test("saves the start/end selectors for a delivered listing", async () => {
    settings.setForTest({ has_logistics: true });
    const listing = await createTestListing({ maxAttendees: 10 });
    await listingsTable.update(listing.id, { usesLogistics: true });
    const van = await logisticsAgentsTable.insert({ name: "Tab Van" });
    const id = await makeAttendee("Legs Person", [{ listingId: listing.id }]);

    const html = await logisticsTabHtml(id);
    expect(html).toContain('name="logistics_start"');
    expect(html).toContain("Tab Van");

    await postLogistics(id, {
      address: "Somewhere",
      [endTimeField()]: "17:00",
      lat: "",
      lng: "",
      [startAgentField()]: String(van.id),
      [startTimeField()]: "09:15",
    });

    expect((await getLogisticsAssignments(id)).get(listing.id)).toEqual({
      endAgentId: null,
      endTime: "17:00",
      startAgentId: van.id,
      startTime: "09:15",
    });
  });

  test("stored assignments survive a save while the selectors are not shown", async () => {
    settings.setForTest({ has_logistics: true });
    const listing = await createTestListing({ maxAttendees: 10 });
    await listingsTable.update(listing.id, { usesLogistics: true });
    const id = await makeAttendee("Keep Legs", [{ listingId: listing.id }]);
    // An assignment exists, but with no agents the selectors never render.
    await setLogisticsAssignments(
      id,
      false,
      new Map([
        [
          listing.id,
          {
            endAgentId: null,
            endTime: "16:00",
            startAgentId: null,
            startTime: "08:00",
          },
        ],
      ]),
    );

    await postLogistics(id, { address: "Somewhere", lat: "", lng: "" });

    expect((await getLogisticsAssignments(id)).get(listing.id)).toEqual({
      endAgentId: null,
      endTime: "16:00",
      startAgentId: null,
      startTime: "08:00",
    });
  });
});

describeWithEnv(
  "attendee Logistics tab — Other Attendees",
  { db: true },
  () => {
    test("lists overlapping attendees with links to their Logistics tabs", async () => {
      const daily = await createDailyTestListing({ maxQuantity: 5 });
      const current = await makeAttendee("Current Person", [
        { date: "2030-01-10", durationDays: 2, listingId: daily.id },
      ]);
      const overlapping = await makeAttendee("Overlap Person", [
        { date: "2030-01-11", durationDays: 2, listingId: daily.id },
      ]);
      const elsewhere = await makeAttendee("Far Away Person", [
        { date: "2030-02-01", durationDays: 1, listingId: daily.id },
      ]);

      const html = await logisticsTabHtml(current);
      expect(html).toContain("Other Attendees");
      expect(html).toContain("Overlap Person");
      expect(html).toContain(`/admin/attendees/${overlapping}/logistics`);
      expect(html).not.toContain("Far Away Person");
      expect(html).not.toContain(`/admin/attendees/${elsewhere}/logistics`);
    });

    test("shows the overlapping bookings' leg times", async () => {
      const daily = await createDailyTestListing({ maxQuantity: 5 });
      const current = await makeAttendee("Times Current", [
        { date: "2030-01-10", durationDays: 1, listingId: daily.id },
      ]);
      const other = await makeAttendee("Times Other", [
        { date: "2030-01-10", durationDays: 1, listingId: daily.id },
      ]);
      await setLogisticsAssignments(
        other,
        false,
        new Map([
          [
            daily.id,
            {
              endAgentId: null,
              endTime: "15:30",
              startAgentId: null,
              startTime: "10:45",
            },
          ],
        ]),
      );

      const html = await logisticsTabHtml(current);
      expect(html).toContain("10:45");
      expect(html).toContain("15:30");
    });

    test("the section is hidden when nothing overlaps", async () => {
      const daily = await createDailyTestListing({ maxQuantity: 5 });
      const alone = await makeAttendee("Alone Person", [
        { date: "2030-01-10", durationDays: 1, listingId: daily.id },
      ]);
      const html = await logisticsTabHtml(alone);
      expect(html).not.toContain("Other Attendees");
    });

    test("the section is hidden for a date-less booking", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const daily = await createDailyTestListing({ maxQuantity: 5 });
      await makeAttendee("Dated Person", [
        { date: "2030-01-10", durationDays: 1, listingId: daily.id },
      ]);
      const dateless = await makeAttendee("Dateless Person", [
        { listingId: listing.id },
      ]);
      const html = await logisticsTabHtml(dateless);
      expect(html).not.toContain("Other Attendees");
    });
  },
);

describe("bookedSpan", () => {
  const entityWith = (
    bookings: Array<{
      start_at: string | null;
      end_at: string | null;
      quantity: number;
    }>,
  ): LoadedAttendee =>
    ({
      attendee: { id: 1 },
      existing: bookings.map((booking, index) => ({
        booking,
        key: String(index),
      })),
    }) as unknown as LoadedAttendee;

  test("spans from the earliest start to the latest end", () => {
    const span = bookedSpan(
      entityWith([
        {
          end_at: "2030-01-12T00:00:00.000Z",
          quantity: 1,
          start_at: "2030-01-10T00:00:00.000Z",
        },
        {
          end_at: "2030-01-15T00:00:00.000Z",
          quantity: 1,
          start_at: "2030-01-11T00:00:00.000Z",
        },
      ]),
    );
    expect(span).toEqual({
      endAt: "2030-01-15T00:00:00.000Z",
      startAt: "2030-01-10T00:00:00.000Z",
    });
  });

  test("ignores no-quantity and date-less bookings", () => {
    const span = bookedSpan(
      entityWith([
        {
          end_at: "2030-01-12T00:00:00.000Z",
          quantity: 0,
          start_at: "2030-01-10T00:00:00.000Z",
        },
        { end_at: null, quantity: 1, start_at: null },
      ]),
    );
    expect(span).toBeNull();
  });
});
