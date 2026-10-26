import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleListingPayment } from "./index/helpers.ts";

/** The committed booking line and its attendee row as the database holds
 *  them, for comparing the rebuilt entry against what was really stored. */
const storedLineOf = async (
  attendeeId: number,
): Promise<{
  checked_in: number;
  end_at: string | null;
  start_at: string | null;
  status_id: number | null;
  ticket_token_index: string;
  webhooks_pending: number;
}> => {
  const row = await queryOne<{
    checked_in: number;
    end_at: string | null;
    start_at: string | null;
    status_id: number | null;
    ticket_token_index: string;
    webhooks_pending: number;
  }>(
    "SELECT line.checked_in, line.end_at, line.start_at, attendee.status_id, attendee.ticket_token_index, attendee.webhooks_pending FROM listing_attendees AS line JOIN attendees AS attendee ON attendee.id = line.attendee_id WHERE line.attendee_id = ?",
    [attendeeId],
  );
  assert(row !== null, "Expected the booking to hold one line");
  return row;
};

describeWithEnv("payment processing > committed entries", { db: true }, () => {
  test("rebuilds the paid booking's entries from the committed rows", async () => {
    const { data, listing } = await singleListingPayment(
      "committed-entries-1",
      2500,
    );
    const booked = await processPaymentSession("committed-entries-1", data);
    assert(booked.success, "Expected the payment to book");
    const attendeeId = booked.attendee.id;
    const stored = await storedLineOf(attendeeId);
    const items: ValidatedItem[] = [
      {
        expectedPrice: 2500,
        item: data.intent.items[0]!,
        listing: (await getListingWithCount(listing.id))!,
        name: listing.name,
      },
    ];

    const entries = await committedEntries(
      attendeeId,
      "the-one-way-code",
      data.session,
      data.intent,
      items,
    );

    expect(entries).toHaveLength(1);
    const { attendee, listing: paired } = entries[0]!;
    // The entry pairs with its listing by id, so the callback can carry the
    // signed facts (name, price) beside the rebuilt row.
    expect(paired.id).toBe(listing.id);
    expect(attendee.listing_id).toBe(listing.id);
    // The buyer's identity comes from the signed intent, the money
    // reference from the paid session.
    expect(attendee.email).toBe(data.intent.email);
    expect(attendee.name).toBe(data.intent.name);
    expect(attendee.payment_id).toBe(data.session.paymentReference);
    expect(attendee.ticket_token).toBe("the-one-way-code");
    // The paid price reads from the posted ledger sale, as a string the
    // attendee record carries.
    expect(attendee.price_paid).toBe("2500");
    expect(attendee.quantity).toBe(1);
    expect(attendee.checked_in).toBe(0);
    expect(attendee.refunded).toBe(false);
    expect(attendee.attachment_downloads).toBe(0);
    // The rebuilt row carries no geo or logistics split: those belong to the
    // attendee's own stored record, not the paid booking's echo.
    expect(attendee.lat).toBe("");
    expect(attendee.lng).toBe("");
    expect(attendee.split_logistics_agents).toBe(false);
    // The rest of the line comes from the committed row itself.
    expect(attendee.date).toBe(
      stored.start_at === null ? null : stored.start_at.slice(0, 10),
    );
    expect(attendee.end_date).toBe(
      stored.end_at === null ? null : stored.end_at.slice(0, 10),
    );
    expect(attendee.status_id).toBe(stored.status_id);
    expect(attendee.ticket_token_index).toBe(stored.ticket_token_index);
    expect(attendee.webhooks_pending).toBe(stored.webhooks_pending);
  });
});
