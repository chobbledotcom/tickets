/**
 * Reader/writer audit for the no-quantity (quantity = 0) sentinel: the
 * customer-facing token flows, the success/reservation pages, the bulk-email
 * recipient queries, and the logistics run sheet all exclude or refuse
 * quantity-0 lines, while admin record views keep them.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getAllAttendeePiiBlobs,
  getAttendeePiiBlobForToken,
  getAttendeePiiBlobsForListings,
  hasActiveBookingLine,
} from "#shared/db/attendees/queries.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import { getAgentRunSheet, setLegDone } from "#shared/db/logistics.ts";
import {
  awaitTestRequest,
  createTestAttendeeWithToken,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

/** Make the attendee's single line a quantity-0 sentinel (price 0, invariant). */
const ghostLine = (attendeeId: number): Promise<unknown> =>
  getDb().execute({
    args: [attendeeId],
    sql: "UPDATE listing_attendees SET quantity = 0, price_paid = 0 WHERE attendee_id = ?",
  });

describeWithEnv("no-quantity audit > token flows", { db: true }, () => {
  test("a quantity-0-only token returns not-found on /t and /t/svg", async () => {
    const { attendee, token } = await createTestAttendeeWithToken(
      "Ghost",
      "ghost@test.com",
    );
    await ghostLine(attendee.id);

    expect((await awaitTestRequest(`/t/${token}`)).status).toBe(404);
    expect((await awaitTestRequest(`/t/${token}/svg`)).status).toBe(404);
  });

  test("a mixed attendee's ticket shows only the real listing", async () => {
    const real = await createTestListing({
      maxAttendees: 50,
      name: "RealShow",
    });
    const ghost = await createTestListing({
      maxAttendees: 50,
      name: "GhostShow",
    });
    const result = await createAttendeeAtomic({
      allowOverbook: true,
      bookings: [
        { listingId: real.id, quantity: 1 },
        { listingId: ghost.id, quantity: 0 },
      ],
      email: "mixed@test.com",
      name: "Mixed",
      source: "admin",
    });
    if (!result.success) throw new Error("setup");

    const body = await (
      await awaitTestRequest(`/t/${result.attendees[0]!.ticket_token}`)
    ).text();
    expect(body).toContain("RealShow");
    expect(body).not.toContain("GhostShow");
  });

  test("the reservation success page drops the CTA for a ghost-only token", async () => {
    const { attendee, token } = await createTestAttendeeWithToken(
      "Resv",
      "resv@test.com",
    );
    await ghostLine(attendee.id);

    const body = await (
      await awaitTestRequest(`/ticket/reserved?tokens=${token}`)
    ).text();
    // No "booking confirmed" CTA linking to a /t URL that would 404.
    expect(body).not.toContain(`/t/${token}`);
  });

  test("the payment success page rejects a ghost-only token", async () => {
    const { attendee, token } = await createTestAttendeeWithToken(
      "Pay",
      "pay@test.com",
    );
    await ghostLine(attendee.id);

    const body = await (
      await awaitTestRequest(`/payment/success?tokens=${token}`)
    ).text();
    expect(body).not.toContain(`/t/${token}`);
  });
});

describeWithEnv("no-quantity audit > attachment auth", { db: true }, () => {
  test("hasActiveBookingLine ignores quantity-0 rows", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const result = await createAttendeeAtomic({
      allowOverbook: true,
      bookings: [{ listingId: listing.id, quantity: 0 }],
      email: "ghost@test.com",
      name: "Ghost",
      source: "admin",
    });
    if (!result.success) throw new Error("setup");
    expect(
      await hasActiveBookingLine(result.attendees[0]!.id, listing.id),
    ).toBe(false);
  });

  test("hasActiveBookingLine is true for a real line", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "real@test.com",
      name: "Real",
    });
    if (!result.success) throw new Error("setup");
    expect(
      await hasActiveBookingLine(result.attendees[0]!.id, listing.id),
    ).toBe(true);
  });
});

describeWithEnv(
  "no-quantity audit > bulk email recipients",
  { db: true },
  () => {
    test("excludes a quantity-0-only attendee from the listing and all audiences", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const real = await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "real@test.com",
        name: "Real",
      });
      const ghost = await createTestAttendeeWithToken(
        "Ghost",
        "ghost@test.com",
        {},
      );
      await ghostLine(ghost.attendee.id);
      if (!real.success) throw new Error("setup");

      // Only the real attendee's blob appears in the listing audience and "all".
      expect((await getAttendeePiiBlobsForListings([listing.id])).length).toBe(
        1,
      );
      expect((await getAllAttendeePiiBlobs()).length).toBe(1);
      // The ghost-only attendee's single-attendee target resolves to no recipient.
      expect(await getAttendeePiiBlobForToken(ghost.token)).toBeNull();
    });
  },
);

describeWithEnv("no-quantity audit > logistics", { db: true }, () => {
  const AGENT = 7;

  /** Insert a booking row with logistics agents on both legs. */
  const insertLogisticsLine = (
    listingId: number,
    attendeeId: number,
    quantity: number,
  ): Promise<unknown> =>
    getDb().execute({
      args: [listingId, attendeeId, quantity],
      sql: `INSERT INTO listing_attendees
              (listing_id, attendee_id, quantity, price_paid, start_at, end_at,
               start_agent_id, end_agent_id)
            VALUES (?, ?, ?, 0, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', ${AGENT}, ${AGENT})`,
    });

  test("the run sheet and setLegDone exclude a quantity-0 line", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    await insertLogisticsLine(listing.id, 1, 2); // real
    await insertLogisticsLine(listing.id, 2, 0); // ghost

    const legs = await getAgentRunSheet([AGENT], ["2026-07-01"]);
    // Only the real line's drop-off leg appears (the ghost is excluded).
    expect(
      legs.filter((l) => l.kind === "start").map((l) => l.attendeeId),
    ).toEqual([1]);

    // setLegDone refuses the ghost line even with the right agent.
    expect(await setLegDone(2, listing.id, "start", true, [AGENT])).toBe(false);
    expect(await setLegDone(1, listing.id, "start", true, [AGENT])).toBe(true);
  });
});
