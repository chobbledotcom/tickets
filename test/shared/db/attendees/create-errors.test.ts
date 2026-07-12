import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createBookingAtomic } from "#shared/db/attendees/api.ts";
import { createAttendeeAtomicImpl } from "#shared/db/attendees/create.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { tx } from "#test-utils/transfer-factory.ts";

describeWithEnv("db > create booking errors", { db: true }, () => {
  test("propagates an unexpected database write failure", async () => {
    const listing = await createTestListing({ maxAttendees: 2 });
    await execute(`CREATE TRIGGER fail_attendee_create
                   BEFORE INSERT ON attendees
                   BEGIN
                     SELECT RAISE(ABORT, 'unexpected create failure');
                   END`);

    await expect(
      createBookingAtomic(
        {
          bookings: [{ listingId: listing.id, pricePaid: 1000, quantity: 1 }],
          email: "failure@example.com",
          name: "Failure",
          ticketToken: "FAILURETOKEN",
        },
        { finalize: null, legs: [], usages: [] },
      ),
    ).rejects.toThrow("unexpected create failure");
  });

  test("stamps a single batch ledger leg on the booking", async () => {
    const listing = await createTestListing({ maxAttendees: 2 });
    const result = await createBookingAtomic(
      {
        bookings: [{ listingId: listing.id, pricePaid: 1000, quantity: 1 }],
        email: "one-leg@example.com",
        name: "One leg",
        ticketToken: "ONELEGTOKEN",
      },
      {
        finalize: null,
        legs: [tx({ eventGroup: "one-leg", reference: "one-leg-ref" })],
        usages: [],
      },
    );
    if (result === "sold-out" || !result.success) {
      throw new Error("Expected one-leg booking");
    }

    const row = await queryOne<{ ledger_event_group: string }>(
      "SELECT ledger_event_group FROM listing_attendees WHERE attendee_id = ?",
      [result.attendees[0]!.id],
    );
    expect(row?.ledger_event_group).toBe("one-leg");
  });

  test("rolls back an interactive partial booking before posting the ledger", async () => {
    const open = await createTestListing({ maxAttendees: 2 });
    const full = await createTestListing({ maxAttendees: 0 });
    let posted = false;

    const result = await createAttendeeAtomicImpl(
      {
        bookings: [
          { listingId: open.id, quantity: 1 },
          { listingId: full.id, quantity: 1 },
        ],
        email: "interactive@example.com",
        name: "Interactive",
      },
      () => {
        posted = true;
        return Promise.resolve();
      },
    );

    expect(result).toEqual({ reason: "capacity_exceeded", success: false });
    expect(posted).toBe(false);
    const rows = await execute(
      "SELECT COUNT(*) AS count FROM listing_attendees WHERE listing_id IN (?, ?)",
      [open.id, full.id],
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });
});
