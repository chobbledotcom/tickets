import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#accounting/kinds.ts";
import { postTransfers } from "#accounting/store.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { LISTING_ATTENDEE_ROW_COLS } from "#db/attendees/queries.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { queryAll } from "#db/client.ts";
import { account } from "#shared/ledger/account.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale, tx } from "#test-utils/ledger.ts";

describeWithEnv("db > attendees > booking row columns", { db: true }, () => {
  test("the booking row projection reads every stored column", async () => {
    const listing = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      unitPrice: 500,
    });
    const ghostListing = await createTestListing({ maxAttendees: 10 });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [
        {
          date: "2026-08-14",
          listingId: listing.id,
          quantity: 1,
        },
        { listingId: ghostListing.id, quantity: 0 },
      ],
      email: "row-cols@example.com",
      name: "Row Cols",
      ticketToken: "row-cols-token",
    });
    if (!made.success) throw new Error("booking setup failed");
    const attendeeId = made.attendees[0]!.id;
    await postListingSale({ attendeeId, gross: 500, listingId: listing.id });
    // Cash handed back makes the quantity-0 placeholder row read refunded:
    // a free line has no sale of its own to reverse.
    await postTransfers([
      tx({
        amount: 100,
        destination: account("external", "world"),
        eventGroup: "cash-back",
        kind: KIND.refundCash,
        reference: "cash-back-1",
        source: account("attendee", attendeeId),
      }),
    ]);

    const [byToken] = await getAttendeesByTokens(["row-cols-token"]);
    expect(byToken).not.toBeNull();
    const booked = byToken!.bookings.find((line) => line.quantity === 1)!;
    const ghost = byToken!.bookings.find((line) => line.quantity === 0)!;
    expect(booked).toMatchObject({
      attachment_downloads: 0,
      checked_in: 0,
      end_at: "2026-08-15T00:00:00.000Z",
      listing_id: listing.id,
      order_token: "",
      package_group_id: 0,
      parent_listing_id: 0,
      price_paid: 500,
      quantity: 1,
      refunded: 0,
      start_at: "2026-08-14T00:00:00Z",
    });
    expect(booked!.ledger_event_group).not.toBe("");
    // The placeholder line sold nothing and its group is empty, so the cash
    // leg alone reads refunded.
    expect(ghost).toMatchObject({
      ledger_event_group: "",
      listing_id: ghostListing.id,
      price_paid: 0,
      quantity: 0,
      refunded: 1,
    });

    // The bare column list builds valid SQL over the real table.
    const rows = await queryAll<{ listing_id: number; quantity: number }>(
      `SELECT ${LISTING_ATTENDEE_ROW_COLS} FROM listing_attendees` +
        " WHERE attendee_id = ? ORDER BY quantity DESC",
      [attendeeId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ listing_id: listing.id, quantity: 1 });
  });
});
