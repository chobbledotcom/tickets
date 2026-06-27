/**
 * Servicing §17 — admin homepage: upcoming service events block.
 *
 * The admin dashboard lists upcoming service events beside active listings,
 * each linking to its servicing page, as a compact `<ul>` block (not a
 * parallel table renderer). Past-dated holds are excluded, matching the
 * listings behaviour.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createDailyTestListing,
  createServicingHold,
  createTestServicingEvent,
  describeWithEnv,
  expectServicingLink,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

/** Room A (daily, cap 5) + a 2-qty "Boiler Service" hold on 2099-07-01. */
const roomAWithBoiler = async () => {
  const listing = await createDailyTestListing({
    maxAttendees: 5,
    name: "Room A",
  });
  const { id } = await createTestServicingEvent({
    bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
    name: "Boiler Service",
  });
  return { id, listing };
};

/** Room A + Room B (daily, cap 10) + one "Annual Inspection" hold spanning both
 *  on 2099-07-01 (qty 2 + 1 = 3 total). */
const twoRoomInspection = async () => {
  const roomA = await createDailyTestListing({
    maxAttendees: 10,
    name: "Room A",
  });
  const roomB = await createDailyTestListing({
    maxAttendees: 10,
    name: "Room B",
  });
  const { id } = await createTestServicingEvent({
    bookings: [
      { date: "2099-07-01", listingId: roomA.id, quantity: 2 },
      { date: "2099-07-01", listingId: roomB.id, quantity: 1 },
    ],
    name: "Annual Inspection",
  });
  return { id, roomA, roomB };
};

describeWithEnv(
  "servicing §17 — admin homepage service events table",
  { db: true },
  () => {
    test("the admin home shows an upcoming service events table linking to /admin/servicing/:id", async () => {
      const { id } = await roomAWithBoiler();
      const body = await renderAdminPage("/admin/");
      expect(body).toContain("Boiler Service");
      expectServicingLink(body, id);
    });

    test("the servicing list shows service events and links to their edit pages", async () => {
      const { id } = await roomAWithBoiler();
      const body = await renderAdminPage("/admin/servicing");
      expect(body).toContain("Boiler Service");
      expect(body).toContain("Room A");
      expect(body).toContain("2099");
      expect(body).toContain("<td>2</td>");
      expectServicingLink(body, id);
    });

    test("the servicing list shows an empty state when no service events exist", async () => {
      const body = await renderAdminPage("/admin/servicing");
      expect(body).toContain("No service events yet");
      expect(body).not.toContain('class="servicing-event"');
    });

    test("a multi-listing hold groups into one row (not one per booking line)", async () => {
      // Previously the reader returned one row per `listing_attendees` booking
      // line, so a multi-listing hold appeared multiple times in the list and on
      // the dashboard. Grouping by service event gives one summary per event,
      // with the held listings joined inside the Listings cell and the quantity
      // being the event total.
      const { id } = await twoRoomInspection();
      const body = await renderAdminPage("/admin/servicing");
      expectServicingLink(body, id);
      expect(body).toContain("Annual Inspection");
      // Both listings appear in one row's Listings cell, quantity is the total.
      expect(body).toContain("Room A, Room B");
      expect(body).toContain("<td>3</td>");
      // Exactly one row for the event (the old shape would have rendered two).
      expect((body.match(/class="servicing-event"/g) ?? []).length).toBe(1);
    });

    test("the dashboard groups a multi-listing hold into one upcoming entry", async () => {
      const { id } = await twoRoomInspection();
      const body = await renderAdminPage("/admin/");
      expectServicingLink(body, id);
      expect(body).toContain("Annual Inspection");
      expect(body).toContain("2 listings");
      // Exactly one link to the event (the old per-line shape would have two).
      expect(
        (body.match(new RegExp(`/admin/servicing/${id}`, "g")) ?? []).length,
      ).toBe(1);
    });

    test("the servicing create page pre-fills listings selected from the calendar checker", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "Room A",
      });
      const body = await renderAdminPage(
        `/admin/servicing/new?select_${listing.id}=1&start_date=2099-07-01`,
      );
      expect(body).toMatch(
        new RegExp(`name="quantity_${listing.id}"[^>]*value="1"`),
      );
      expect(body).toContain('name="start_date"');
      expect(body).toContain('value="2099-07-01"');
    });

    test("the servicing edit page renders saved booking quantities", async () => {
      const { id, listing } = await roomAWithBoiler();
      const body = await renderAdminPage(`/admin/servicing/${id}`);
      expect(body).toMatch(
        new RegExp(`name="quantity_${listing.id}"[^>]*value="2"`),
      );
      expect(body).toContain('value="2099-07-01"');
    });

    test("only upcoming service events are listed (past-dated holds are excluded)", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "Room A",
      });
      const past = await createServicingHold({
        date: "2000-07-01",
        listing: { maxAttendees: 5, name: "Room A" },
        name: "Past Service",
        quantity: 2,
      });
      const future = await createServicingHold({
        date: "2099-07-01",
        listing: { maxAttendees: 5, name: "Room A" },
        name: "Future Service",
        quantity: 2,
      });
      const body = await renderAdminPage("/admin/");
      expect(body).toContain("Future Service");
      expect(body).not.toContain("Past Service");
      expect(body).toContain(`/admin/servicing/${future.id}`);
      expect(body).not.toContain(`/admin/servicing/${past.id}`);
    });
  },
);
