// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  createServicingEvent,
  recordServiceCost,
  renderAdminPage,
  updateServicingEvent,
} from "#test-utils/servicing.ts";

// jscpd:ignore-end

describeWithEnv("servicing cost page", { db: true }, () => {
  test("keeps an inactive former hold's name and exact owner Money link", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Old boiler room",
    });
    const remaining = await createTestListing({
      maxAttendees: 10,
      name: "Main hall",
    });
    const event = await createServicingEvent({
      bookings: [
        { listingId: listing.id, quantity: 1 },
        { listingId: remaining.id, quantity: 1 },
      ],
      name: "Annual service",
    });
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: "2026-07-01T00:00:00.000Z",
      servicingId: event.id,
    });
    await updateServicingEvent(event.id, {
      bookings: [{ listingId: remaining.id, quantity: 1 }],
      name: event.name,
    });
    await deactivateTestListing(listing.id);

    const body = await renderAdminPage(`/admin/servicing/${event.id}`);

    expect(body).toContain(listing.name);
    expect(body).toContain(
      `href="/admin/ledger?listing=${listing.id}">${listing.name}</a>`,
    );
  });
});
