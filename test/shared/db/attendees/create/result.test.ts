import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { queryOne } from "#db/client.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const requireAttendee = (
  result: Awaited<ReturnType<typeof createAttendeeAtomic>>,
) => {
  if (!result.success) throw new Error("expected attendee creation to succeed");
  return result.attendees[0]!;
};

describeWithEnv("db > attendees > create result", { db: true }, () => {
  test("returns and stores every default attendee value", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });

    const attendee = requireAttendee(
      await createAttendeeAtomic({
        bookings: [{ listingId: listing.id }],
        email: "defaults@example.com",
        name: "Defaults",
        ticketToken: "default-result-token",
      }),
    );

    expect(attendee).toMatchObject({
      address: "",
      attachment_downloads: 0,
      checked_in: false,
      date: null,
      email: "defaults@example.com",
      end_date: null,
      kind: "attendee",
      lat: "",
      lng: "",
      name: "Defaults",
      package_group_id: 0,
      payment_id: "",
      phone: "",
      pii_blob: "",
      price_paid: "0",
      quantity: 1,
      refunded: false,
      remaining_balance: 0,
      special_instructions: "",
      split_logistics_agents: false,
      status_id: null,
      ticket_token: "default-result-token",
    });
    expect(
      await queryOne<{ kind: string }>(
        "SELECT kind FROM attendees WHERE id = ?",
        [attendee.id],
      ),
    ).toEqual({ kind: "attendee" });
    expect(
      await queryOne<{ public_booking_count: number }>(
        "SELECT public_booking_count FROM contact_preferences",
      ),
    ).toEqual({ public_booking_count: 1 });
    expect(
      await getAttendeeOrNull(attendee.id, await getTestPrivateKey()),
    ).toMatchObject({ payment_id: "", price_paid: "0" });
  });

  test("returns custom booking and contact values", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Package" });
    const listing = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
    });

    const attendee = requireAttendee(
      await createAttendeeAtomic({
        address: "1 Example Road",
        bookings: [
          {
            date: "2026-06-24",
            durationDays: 2,
            listingId: listing.id,
            packageGroupId: group.id,
            pricePaid: 25,
            quantity: 2,
          },
        ],
        email: "custom@example.com",
        kind: SERVICING_KIND,
        name: "Custom",
        paymentId: "payment-custom",
        phone: "+441234567890",
        remainingBalance: 75,
        special_instructions: "Use the side door",
        ticketToken: "custom-result-token",
      }),
    );

    expect(attendee).toMatchObject({
      address: "1 Example Road",
      date: "2026-06-24",
      end_date: "2026-06-26",
      kind: SERVICING_KIND,
      package_group_id: group.id,
      payment_id: "payment-custom",
      phone: "+441234567890",
      price_paid: "25",
      quantity: 2,
      remaining_balance: 75,
      special_instructions: "Use the side door",
      ticket_token: "custom-result-token",
    });
  });
});
