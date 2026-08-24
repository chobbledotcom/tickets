import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  enablePublicOrder,
  fetchAvailability,
  orderDate,
  selectOrder,
} from "#test/features/public/order/helpers.ts";
import { expectRedirect, expectStatus } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describeWithEnv(
  "server (public order) — selection and live availability",
  { db: true, triggers: true },
  () => {
    describe("GET /order with a selection (redirect into the booking page)", () => {
      enablePublicOrder();

      test("redirects one selected item into its pre-filled booking page", async () => {
        const item = await createTestListing({
          maxQuantity: 5,
          name: "Widget",
        });
        const response = await selectOrder([item.id]);
        expectRedirect(response, `/ticket/${item.slug}?q_${item.id}=1`);
      });

      test("redirects multiple items to the multi-listing booking page", async () => {
        const a = await createTestListing({ name: "Alpha" });
        const b = await createTestListing({ name: "Bravo" });
        const location = expectRedirect(await selectOrder([a.id, b.id]));
        expect(location).toContain(a.slug);
        expect(location).toContain(b.slug);
        expect(location).toContain(`q_${a.id}=1`);
        expect(location).toContain(`q_${b.id}=1`);
      });

      test("includes a sold-out pick as a slug but does not pre-fill it", async () => {
        const open = await createTestListing({ name: "In Stock" });
        const sold = await createTestListing({
          maxAttendees: 1,
          name: "No Stock",
        });
        await createTestAttendee(sold.id, sold.slug, "Buyer", "b@example.com");

        const location = expectRedirect(await selectOrder([open.id, sold.id]));
        expect(location).toContain(sold.slug);
        expect(location).toContain(`q_${open.id}=1`);
        expect(location).not.toContain(`q_${sold.id}=1`);
      });

      test("redirects with no pre-fill when every pick is sold out", async () => {
        const sold = await createTestListing({ maxAttendees: 1, name: "Gone" });
        await createTestAttendee(sold.id, sold.slug, "Buyer", "b@example.com");
        const location = expectRedirect(await selectOrder([sold.id]));
        expect(location).toBe(`/ticket/${sold.slug}`);
      });

      test("ignores ids that are not bookable listings and shows the gallery", async () => {
        await createTestListing({ name: "Only Me" });
        // No valid selection → fall through to the gallery, not a redirect.
        const response = await handleRequest(
          mockRequest("/order?select_99999=1"),
        );
        expectStatus(200)(response);
      });

      test("drops a crafted package id that names no bookable package", async () => {
        const solo = await createTestListing({ name: "Lantern" });
        const location = expectRedirect(
          await handleRequest(
            mockRequest(`/order?select_${solo.id}=1&select_package_99999=1`),
          ),
        );
        // The bogus bundle contributes no slug; the real pick still books.
        expect(location).toBe(`/ticket/${solo.slug}?q_${solo.id}=1`);
      });

      test("redirects a package pick to its booking page without a pre-fill", async () => {
        const group = await createTestGroup({
          isPackage: true,
          name: "Camp Bundle",
          slug: "camp-bundle",
        });
        await createTestListing({ groupId: group.id, name: "Bundle Tent" });
        // A package needs no q_ pre-fill: its count selector defaults to one.
        const response = await handleRequest(
          mockRequest(`/order?select_package_${group.id}=1`),
        );
        expect(expectRedirect(response)).toBe(`/ticket/${group.slug}`);
      });

      test("orders the booking page's slugs by when things were added", async () => {
        const group = await createTestGroup({
          isPackage: true,
          name: "Camp Bundle",
          slug: "camp-bundle",
        });
        await createTestListing({ groupId: group.id, name: "Bundle Tent" });
        const solo = await createTestListing({ name: "Lantern" });
        // The hidden order field says the package was added first, so its slug
        // leads even though the listing sorts first by id.
        const response = await handleRequest(
          mockRequest(
            `/order?select_${solo.id}=1&select_package_${group.id}=1` +
              `&order=package:${group.id},listing:${solo.id}`,
          ),
        );
        expect(expectRedirect(response)).toBe(
          `/ticket/${group.slug}+${solo.slug}?q_${solo.id}=1`,
        );
      });

      test("a tampered order value cannot smuggle an unselected item along", async () => {
        const chosen = await createTestListing({ name: "Chosen" });
        const other = await createTestListing({ name: "Unchosen" });
        const location = expectRedirect(
          await handleRequest(
            mockRequest(
              `/order?select_${chosen.id}=1&order=listing:${other.id},listing:${chosen.id}`,
            ),
          ),
        );
        expect(location).toBe(`/ticket/${chosen.slug}?q_${chosen.id}=1`);
      });

      test("carries the chosen date into the booking page", async () => {
        const daily = await createDailyTestListing({ name: "Day Pass" });
        const date = orderDate();
        const location = expectRedirect(
          await handleRequest(
            mockRequest(`/order?select_${daily.id}=1&start_date=${date}`),
          ),
        );
        expect(location).toBe(
          `/ticket/${daily.slug}?q_${daily.id}=1&date=${date}`,
        );
      });
    });

    describe("GET /order/availability (live evaluation)", () => {
      enablePublicOrder();

      test("is gated like the order page", async () => {
        await settings.update.orderEnabled(false);
        const response = await handleRequest(
          mockRequest("/order/availability"),
        );
        expectStatus(404)(response);
      });

      test("greys a card whose capacity the visitor's own pick holds, naming it", async () => {
        const shared = await createTestGroup({
          maxAttendees: 1,
          name: "One Slot",
        });
        const morning = await createTestListing({
          groupId: shared.id,
          name: "Morning Cruise",
        });
        const afternoon = await createTestListing({
          groupId: shared.id,
          name: "Afternoon Cruise",
        });

        const data = await fetchAvailability(`select_${morning.id}=1`);
        expect(data.dateNeeded).toBe(false);
        expect(data.states[`listing:${morning.id}`]).toEqual({
          label: "",
          state: "selected",
        });
        // Not "Sold out": the visitor's own earlier choice holds the group's
        // last slot, and the label says which one to remove.
        expect(data.states[`listing:${afternoon.id}`]).toEqual({
          label: "Remove Morning Cruise to add",
          state: "blocked",
        });
      });

      test("asks for a date before judging date-needing picks", async () => {
        const chosen = await createDailyTestListing({ name: "Boat Day" });
        const other = await createDailyTestListing({ name: "Kayak Day" });

        const withoutDate = await fetchAvailability(`select_${chosen.id}=1`);
        expect(withoutDate.dateNeeded).toBe(true);
        expect(withoutDate.states[`listing:${other.id}`]).toEqual({
          label: "Pick a date to see availability",
          state: "needs_date",
        });

        const withDate = await fetchAvailability(
          `select_${chosen.id}=1&start_date=${orderDate()}`,
        );
        expect(withDate.dateNeeded).toBe(false);
        expect(withDate.states[`listing:${other.id}`]).toEqual({
          label: "",
          state: "available",
        });
      });

      test("a fixed multi-day booking is judged across its whole span", async () => {
        // The 2-day pass occupies its start date AND the next day; with day two
        // already full, a booking starting today can never fit — the card must
        // read sold out for that date, matching what the form would enforce.
        const daily = await createDailyTestListing({
          durationDays: 2,
          maxAttendees: 1,
          maxQuantity: 1,
          name: "Two Day Pass",
        });
        const start = orderDate();
        const { attendeesApi } = await import("#db/attendees/api.ts");
        const fill = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { date: addDays(start, 1), listingId: daily.id, quantity: 1 },
          ],
          email: "early@test.com",
          name: "Early Bird",
        });
        expect(fill.success).toBe(true);

        // Dateless and buyer-chosen-span items are judged at one day beside it.
        const mug = await createTestListing({ name: "Dated Mug" });
        const flex = await createDailyTestListing({
          customisableDays: true,
          dayPrices: { 1: 100, 2: 180 },
          durationDays: 2,
          name: "Flex Pass",
        });

        const data = await fetchAvailability(`start_date=${start}`);
        expect(data.states[`listing:${daily.id}`]).toEqual({
          label: "Sold Out",
          state: "unavailable",
        });
        expect(data.states[`listing:${mug.id}`]).toEqual({
          label: "",
          state: "available",
        });
        expect(data.states[`listing:${flex.id}`]).toEqual({
          label: "",
          state: "available",
        });
      });

      test("a shared group pool is judged across the selections' spans", async () => {
        // Two 2-day barges share a group capped at 3. A one-day hire already
        // loads the group's SECOND day with 2 units, so only 1 unit fits on
        // every day a 2-day booking starting today occupies. Selecting one
        // barge takes it — the other must read blocked, exactly as the form
        // would refuse it, even though the START day still has room for both.
        const group = await createTestGroup({ maxAttendees: 3, name: "Fleet" });
        const bargeA = await createDailyTestListing({
          durationDays: 2,
          groupId: group.id,
          maxAttendees: 10,
          name: "Barge A",
        });
        const bargeB = await createDailyTestListing({
          durationDays: 2,
          groupId: group.id,
          maxAttendees: 10,
          name: "Barge B",
        });
        const dayBoat = await createDailyTestListing({
          durationDays: 1,
          groupId: group.id,
          maxAttendees: 10,
          maxQuantity: 5,
          name: "Day Boat",
        });
        const start = orderDate();
        const { attendeesApi } = await import("#db/attendees/api.ts");
        const fill = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { date: addDays(start, 1), listingId: dayBoat.id, quantity: 2 },
          ],
          email: "second-day@test.com",
          name: "Second Day",
        });
        expect(fill.success).toBe(true);

        const data = await fetchAvailability(
          `start_date=${start}&select_${bargeA.id}=1`,
        );
        expect(data.states[`listing:${bargeA.id}`]).toEqual({
          label: "",
          state: "selected",
        });
        expect(data.states[`listing:${bargeB.id}`]).toEqual({
          label: "Remove Barge A to add",
          state: "blocked",
        });
      });

      test("a date the calendar cannot serve reads as sold out for that day", async () => {
        const daily = await createDailyTestListing({
          maximumDaysAfter: 1,
          name: "Near Pass",
        });
        const farDate = addDays(todayInTz("UTC"), 30);
        const data = await fetchAvailability(`start_date=${farDate}`);
        expect(data.states[`listing:${daily.id}`]).toEqual({
          label: "Sold Out",
          state: "unavailable",
        });
      });
    });
  },
);
