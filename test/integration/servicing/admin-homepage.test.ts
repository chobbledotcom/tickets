/**
 * Branch cover for the servicing list and edit pages, beside the story
 * `@story:servicing.the-work-coming-up`.
 *
 * The story owns what the organiser reads: the Servicing page and the
 * dashboard, one entry per service event however many listings it holds,
 * work whose day has passed dropping off, the empty state, and a read-only
 * site naming the work without offering a way in.
 *
 * These own the form markup a story must not name — the per-listing quantity
 * boxes the create and edit pages render, and the values the calendar checker
 * hands over in the address it sends the organiser to.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createTestServicingEvent,
  renderAdminPage,
} from "#test-utils/servicing.ts";

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

describeWithEnv("servicing — the service event form", { db: true }, () => {
  test("the create page pre-fills listings selected from the calendar checker", async () => {
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

  test("the edit page renders saved booking quantities", async () => {
    const { id, listing } = await roomAWithBoiler();
    const body = await renderAdminPage(`/admin/servicing/${id}`);
    expect(body).toMatch(
      new RegExp(`name="quantity_${listing.id}"[^>]*value="2"`),
    );
    expect(body).toContain('value="2099-07-01"');
  });
});
