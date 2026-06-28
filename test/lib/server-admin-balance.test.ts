import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { logActivity } from "#shared/db/activityLog.ts";
import { attendeeStatusesTable } from "#shared/db/attendee-statuses.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import {
  adminGet,
  createTestListing,
  describeWithEnv,
  expectHtml,
  setupStripe,
  testRequiresAuth,
} from "#test-utils";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { postListingSale } from "#test-utils/ledger.ts";

/** A settle identity (session id + business time) for settleAttendeeBalance. */
const settle = (id = "settle-session") => ({
  id,
  occurredAt: "2026-06-21T00:00:00.000Z",
});

/** Create an attendee owing `remaining` on a listing booking with `deposit`
 *  already paid, posting the gross sale + deposit legs so the balance projects. */
const owedAttendee = async (
  listingId: number,
  statusId: number | null,
  remaining: number,
  deposit = 100,
): Promise<number> => {
  const result = await createAttendeeAtomic({
    bookings: [{ listingId, pricePaid: deposit, quantity: 1 }],
    email: "guest@example.com",
    name: "Guest",
    remainingBalance: remaining,
    statusId,
  });
  if (!result.success) throw new Error("setup failed");
  const attendeeId = result.attendees[0]!.id;
  await postListingSale({
    amountPaid: deposit,
    attendeeId,
    gross: deposit + remaining,
    listingId,
  });
  return attendeeId;
};

const reservedAttendee = async () => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name: "Gala Ticket",
    thankYouUrl: "https://example.com",
  });
  const reservation = await attendeeStatusesTable.insert({
    isReservation: true,
    name: "Reserved",
    reservationAmount: "10%",
  });
  return owedAttendee(listing.id, reservation.id, 1500);
};

describeWithEnv("server (admin attendee balance)", { db: true }, () => {
  testRequiresAuth("/admin/attendees/1/balance");

  test("shows the deposit breakdown, payment link and history", async () => {
    // A provider must be configured for the customer pay link to function.
    await setupStripe();
    const attendeeId = await reservedAttendee();
    await logActivity("Deposit received", null, attendeeId);

    const response = await adminGet(`/admin/attendees/${attendeeId}/balance`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Reservation balance");
    expect(html).toContain("Reservation deposit");
    expect(html).toContain("Balance outstanding");
    // The signed customer link points at the public pay page.
    expect(html).toContain("/pay/bal1.");
    // The attendee's history is listed.
    expect(html).toContain("Deposit received");
  });

  test("withholds the payment link for a reservation when no provider is configured", async () => {
    // A reservation status, but no payment provider — the /pay POST would
    // dead-end, so the customer link must not be offered.
    const attendeeId = await reservedAttendee();
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/balance`), {
      contains: [
        "Balance outstanding",
        "collect the balance directly from the customer",
      ],
      notContains: ["/pay/"],
    });
  });

  test("returns 404 for a missing attendee", async () => {
    const response = await adminGet("/admin/attendees/9999/balance");
    expect(response.status).toBe(404);
  });

  test("shows a fully-paid state once the balance is settled", async () => {
    const attendeeId = await reservedAttendee();
    await settleAttendeeBalance(attendeeId, 1500, settle());
    const response = await adminGet(`/admin/attendees/${attendeeId}/balance`);
    const html = await response.text();
    expect(html).toContain("This booking is fully paid");
    // No payment link when nothing is outstanding.
    expect(html).not.toContain("/pay/bal1.");
  });

  test("handles an attendee with no status and a non-reservation balance", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    const attendeeId = await owedAttendee(listing.id, null, 1500);
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/balance`), {
      contains: [
        "Balance outstanding",
        "collect the balance directly from the customer",
      ],
      notContains: ["Reservation deposit", "/pay/"],
      status: 200,
    });
  });

  test("withholds the payment link for a non-reservation status with a balance", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    // A named, non-reservation status (mirrors a provider-less booking sitting
    // in the seeded public/paid default) still carries an outstanding balance.
    const confirmed = await attendeeStatusesTable.insert({
      isReservation: false,
      name: "Confirmed",
      reservationAmount: "0",
    });
    // A provider-less owed booking: full value owed, nothing paid up front.
    const attendeeId = await owedAttendee(listing.id, confirmed.id, 1500, 0);
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/balance`), {
      contains: [
        "Balance outstanding",
        "collect the balance directly from the customer",
      ],
      notContains: ["/pay/"],
    });
  });

  test("the attendee page links to the balance panel when a balance is due", async () => {
    // A linked payment id makes the read-only payment-details panel (which hosts
    // the "Balance outstanding" link) render; the deposit + sale legs leave £15
    // owed in the ledger so the outstanding-balance block shows.
    const { attendeeId } = await createReservedAttendee(1500, {
      paymentId: "pi_deposit",
    });
    const response = await adminGet(`/admin/attendees/${attendeeId}`);
    const html = await response.text();
    expect(html).toContain("Balance outstanding");
    expect(html).toContain(`/admin/attendees/${attendeeId}/balance`);
  });
});
