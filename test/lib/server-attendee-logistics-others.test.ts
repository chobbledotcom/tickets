/**
 * The attendee Logistics tab, part two: demo-mode masking, the failed save
 * keeping the submitted selectors, the Other Attendees list, and the booked
 * window helpers. The tab's core GET/POST behaviour lives in
 * server-attendee-logistics-tab.test.ts.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  endTimeField,
  startAgentField,
  startTimeField,
} from "#routes/admin/attendee-logistics.ts";
import {
  bookedIntervals,
  overlapsAnyInterval,
} from "#routes/admin/attendee-logistics-tab.ts";
import type { LoadedAttendee } from "#routes/admin/attendee-page-data.ts";
import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import {
  getLogisticsAssignments,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { DEMO_ADDRESSES } from "#shared/demo/samples.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildAttendeeEditForm } from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  deliveredListingSetup,
  logisticsTabHtml,
  makeAttendee,
  postLogistics,
} from "#test-utils/logistics-tab.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("attendee Logistics tab — demo mode", { db: true }, () => {
  test("a demo instance masks the address and clears the pin before saving", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Demo Person", [{ listingId: listing.id }]);
    setDemoModeForTest(true);
    try {
      await postLogistics(id, {
        address: "1 Real Street, Realtown",
        lat: "51.503396",
        lng: "-0.127640",
      });
    } finally {
      setDemoModeForTest(false);
    }

    const saved = (await getAttendeeOrNull(id, await getTestPrivateKey()))!;
    expect(saved.address).not.toBe("1 Real Street, Realtown");
    expect(DEMO_ADDRESSES).toContain(saved.address);
    expect(saved.lat).toBe("");
    expect(saved.lng).toBe("");
  });
});

describeWithEnv("the Edit tab and the Logistics pin", { db: true }, () => {
  /** Pin an attendee's address on the Logistics tab, then save the Edit tab
   * form with the given address and return the stored coordinates. */
  const editAfterPinning = async (editedAddress: string) => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Pin Person", [{ listingId: listing.id }]);
    await postLogistics(id, {
      address: "10 Downing Street, LONDON, SW1A 2AA",
      lat: "51.503396",
      lng: "-0.127640",
    });

    const form = await buildAttendeeEditForm(id, {
      address: editedAddress,
      name: "Pin Person",
    });
    const { response } = await adminFormPost(`/admin/attendees/${id}`, form);
    expect(response.status).toBe(302);
    const saved = (await getAttendeeOrNull(id, await getTestPrivateKey()))!;
    return { lat: saved.lat, lng: saved.lng };
  };

  test("an edit that keeps the address keeps the pin", async () => {
    const pin = await editAfterPinning("10 Downing Street, LONDON, SW1A 2AA");
    expect(pin).toEqual({ lat: "51.503396", lng: "-0.127640" });
  });

  test("an edit that changes the address clears the now-stale pin", async () => {
    const pin = await editAfterPinning("11 Downing Street, LONDON, SW1A 2AB");
    expect(pin).toEqual({ lat: "", lng: "" });
  });
});

describeWithEnv(
  "attendee Logistics tab — failed save keeps the selectors",
  { db: true },
  () => {
    test("a 400 re-render shows the submitted times, not the saved ones", async () => {
      const { id, listing, van } = await deliveredListingSetup(
        "Keep Van",
        "Keep Input",
      );
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

      // Submit new times together with an invalid pin.
      const response = await postLogistics(id, {
        address: "Somewhere",
        [endTimeField()]: "18:30",
        lat: "91",
        lng: "0",
        [startAgentField()]: String(van.id),
        [startTimeField()]: "10:30",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      // The form re-renders with the operator's submitted choices…
      expect(html).toContain('value="10:30"');
      expect(html).toContain('value="18:30"');
      expect(html).not.toContain('value="08:00"');
      // …while nothing was saved.
      expect((await getLogisticsAssignments(id)).get(listing.id)).toEqual({
        endAgentId: null,
        endTime: "16:00",
        startAgentId: null,
        startTime: "08:00",
      });
    });
  },
);

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

    test("shows the overlapping bookings' leg times and quantity", async () => {
      const daily = await createDailyTestListing({ maxQuantity: 5 });
      const current = await makeAttendee("Times Current", [
        { date: "2030-01-10", durationDays: 1, listingId: daily.id },
      ]);
      const other = await makeAttendee("Times Other", [
        {
          date: "2030-01-10",
          durationDays: 1,
          listingId: daily.id,
          quantity: 2,
        },
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
      // A multi-unit booking shows its quantity beside the listing name.
      expect(html).toContain("×2");
    });

    test("a booking in the gap between two bookings is not listed", async () => {
      const daily = await createDailyTestListing({ maxQuantity: 5 });
      const current = await makeAttendee("Gap Current", [
        { date: "2030-01-01", durationDays: 1, listingId: daily.id },
        { date: "2030-01-10", durationDays: 1, listingId: daily.id },
      ]);
      await makeAttendee("Gap Middle Person", [
        { date: "2030-01-05", durationDays: 1, listingId: daily.id },
      ]);
      await makeAttendee("Gap Edge Person", [
        { date: "2030-01-10", durationDays: 1, listingId: daily.id },
      ]);

      const html = await logisticsTabHtml(current);
      expect(html).toContain("Gap Edge Person");
      expect(html).not.toContain("Gap Middle Person");
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

describe("bookedIntervals and overlapsAnyInterval", () => {
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

  test("collects one window per real dated booking", () => {
    const intervals = bookedIntervals(
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
    expect(intervals).toEqual([
      {
        endAt: "2030-01-12T00:00:00.000Z",
        startAt: "2030-01-10T00:00:00.000Z",
      },
      {
        endAt: "2030-01-15T00:00:00.000Z",
        startAt: "2030-01-11T00:00:00.000Z",
      },
    ]);
  });

  test("ignores no-quantity and date-less bookings", () => {
    const intervals = bookedIntervals(
      entityWith([
        {
          end_at: "2030-01-12T00:00:00.000Z",
          quantity: 0,
          start_at: "2030-01-10T00:00:00.000Z",
        },
        { end_at: null, quantity: 1, start_at: null },
      ]),
    );
    expect(intervals).toEqual([]);
  });

  test("a booking in the gap between two windows does not overlap", () => {
    const intervals = [
      { endAt: "2030-01-02", startAt: "2030-01-01" },
      { endAt: "2030-01-11", startAt: "2030-01-10" },
    ];
    const inGap = { end_at: "2030-01-06", start_at: "2030-01-05" };
    const onWindow = { end_at: "2030-01-11", start_at: "2030-01-10" };
    expect(overlapsAnyInterval(intervals, inGap)).toBe(false);
    expect(overlapsAnyInterval(intervals, onWindow)).toBe(true);
  });
});
