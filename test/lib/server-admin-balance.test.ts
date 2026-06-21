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
  testRequiresAuth,
} from "#test-utils";

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
  const result = await createAttendeeAtomic({
    bookings: [{ listingId: listing.id, pricePaid: 100, quantity: 1 }],
    email: "guest@example.com",
    name: "Guest",
    remainingBalance: 1500,
    statusId: reservation.id,
  });
  if (!result.success) throw new Error("setup failed");
  return result.attendees[0]!.id;
};

describeWithEnv("server (admin attendee balance)", { db: true }, () => {
  testRequiresAuth("/admin/attendees/1/balance");

  test("shows the deposit breakdown, payment link and history", async () => {
    const attendeeId = await reservedAttendee();
    await logActivity("Deposit received", null, attendeeId);

    const { response } = await adminGet(
      `/admin/attendees/${attendeeId}/balance`,
    );
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

  test("returns 404 for a missing attendee", async () => {
    const { response } = await adminGet("/admin/attendees/9999/balance");
    expect(response.status).toBe(404);
  });

  test("shows a fully-paid state once the balance is settled", async () => {
    const attendeeId = await reservedAttendee();
    await settleAttendeeBalance(attendeeId, 1500);
    const { response } = await adminGet(
      `/admin/attendees/${attendeeId}/balance`,
    );
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
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, pricePaid: 100, quantity: 1 }],
      email: "guest@example.com",
      name: "Guest",
      remainingBalance: 1500,
      statusId: null,
    });
    if (!result.success) throw new Error("setup failed");
    const { response } = await adminGet(
      `/admin/attendees/${result.attendees[0]!.id}/balance`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Balance outstanding");
    // No reservation status, so no deposit line is shown.
    expect(html).not.toContain("Reservation deposit");
    // The online /pay link only serves reservations, so it is withheld here;
    // the balance is collected offline instead.
    expect(html).not.toContain("/pay/");
    expect(html).toContain("Collect this balance directly");
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
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, pricePaid: 0, quantity: 1 }],
      email: "guest@example.com",
      name: "Guest",
      remainingBalance: 1500,
      statusId: confirmed.id,
    });
    if (!result.success) throw new Error("setup failed");
    const { response } = await adminGet(
      `/admin/attendees/${result.attendees[0]!.id}/balance`,
    );
    const html = await response.text();
    expect(html).toContain("Balance outstanding");
    expect(html).not.toContain("/pay/");
    expect(html).toContain("Collect this balance directly");
  });

  test("the attendee page links to the balance panel when a balance is due", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    const reservation = await attendeeStatusesTable.insert({
      isReservation: true,
      name: "Reserved",
      reservationAmount: "10%",
    });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, pricePaid: 100, quantity: 1 }],
      email: "guest@example.com",
      name: "Guest",
      paymentId: "pi_deposit",
      remainingBalance: 1500,
      statusId: reservation.id,
    });
    if (!result.success) throw new Error("setup failed");
    const attendeeId = result.attendees[0]!.id;
    const { response } = await adminGet(`/admin/attendees/${attendeeId}`);
    const html = await response.text();
    expect(html).toContain("Balance outstanding");
    expect(html).toContain(`/admin/attendees/${attendeeId}/balance`);
  });
});
