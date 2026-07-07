import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatusesTable } from "#shared/db/attendee-statuses.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  adminGet,
  awaitTestRequest,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectHtml,
  expectHtmlResponse,
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

describeWithEnv("server (admin attendee ledger)", { db: true }, () => {
  testRequiresAuth("/admin/attendees/1/ledger");

  test("shows the order summary, statement, payment link and activity pointer", async () => {
    // A provider must be configured for the customer pay link to function.
    await setupStripe();
    const attendeeId = await reservedAttendee();

    const response = await adminGet(`/admin/attendees/${attendeeId}/ledger`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Reservation balance");
    expect(html).toContain("Reservation deposit");
    expect(html).toContain("Balance outstanding");
    // The account statement (the "bits already there") renders alongside, with
    // its running-balance table's counterparty column.
    expect(html).toContain("<th>Counterparty</th>");
    // The signed customer link points at the public pay page.
    expect(html).toContain("/pay/bal1.");
    // When the link IS shown, the owner is told only quantity > 0 lines are
    // charged, so the mixed case (some real, some no-quantity lines) is clear.
    expect(html).toContain("Only items with a quantity");
    // The history section is just a pointer to the Activity tab (no log list).
    expect(html).toContain(
      "See the full plain-English log on the Activity tab",
    );
    expect(html).toContain(`/admin/attendees/${attendeeId}/activity`);
  });

  test("explains why the payment link is missing for a reservation with no provider", async () => {
    // A reservation status, but no payment provider — the /pay POST would
    // dead-end, so the customer link must not be offered and the reason (no
    // provider) is spelled out, not the not-a-reservation one.
    const attendeeId = await reservedAttendee();
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/ledger`), {
      contains: [
        "Balance outstanding",
        "Collect this balance directly",
        "no payment provider is connected",
      ],
      notContains: [
        "/pay/",
        "only reservations can take a balance payment online",
      ],
    });
  });

  test("returns 404 for a missing attendee", async () => {
    const response = await adminGet("/admin/attendees/9999/ledger");
    expect(response.status).toBe(404);
  });

  test("shows a fully-paid state once the balance is settled", async () => {
    const attendeeId = await reservedAttendee();
    await settleAttendeeBalance(attendeeId, 1500, settle());
    const response = await adminGet(`/admin/attendees/${attendeeId}/ledger`);
    const html = await response.text();
    expect(html).toContain("This booking is fully paid");
    // No payment link when nothing is outstanding.
    expect(html).not.toContain("/pay/bal1.");
  });

  test("explains both reasons for a no-status, non-reservation balance", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    const attendeeId = await owedAttendee(listing.id, null, 1500);
    // No reservation status AND no provider — both reasons are listed.
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/ledger`), {
      contains: [
        "Balance outstanding",
        "Collect this balance directly",
        "only reservations can take a balance payment online",
        "no payment provider is connected",
      ],
      notContains: ["Reservation deposit", "/pay/"],
      status: 200,
    });
  });

  test("withholds the pay link (real-line reason) for a no-quantity-only reservation", async () => {
    // A reservation with a provider and an outstanding balance, but its only
    // line is no-quantity — the public /pay page refuses this, so the admin
    // panel must not offer a dead-end link and must say why.
    await setupStripe();
    const attendeeId = await reservedAttendee();
    await getDb().execute({
      args: [attendeeId],
      sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
    });
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/ledger`), {
      contains: [
        "Collect this balance directly",
        "the order has no payable lines",
      ],
      notContains: [
        "/pay/",
        "only reservations can take a balance payment online",
        "no payment provider is connected",
      ],
    });
  });

  test("explains the not-a-reservation reason for a named non-reservation status", async () => {
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
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/ledger`), {
      contains: [
        "Balance outstanding",
        "Collect this balance directly",
        "only reservations can take a balance payment online",
      ],
      notContains: ["/pay/"],
    });
  });

  test("the attendee page links to the ledger panel when a balance is due", async () => {
    // A linked payment id makes the read-only payment-details panel (which hosts
    // the "Balance outstanding" link) render; the deposit + sale legs leave £15
    // owed in the ledger so the outstanding-balance block shows.
    const { attendeeId } = await createReservedAttendee(1500, {
      paymentId: "pi_deposit",
    });
    const response = await adminGet(`/admin/attendees/${attendeeId}`);
    const html = await response.text();
    expect(html).toContain("Balance outstanding");
    expect(html).toContain(`/admin/attendees/${attendeeId}/ledger`);
    // The tab strip alone also carries that href, so pin the payment-details
    // link itself by its anchor text — it must render for owners.
    expect(html).toContain("view ledger &amp; payment link");
  });

  test("a manager's overview shows the balance owed but never the owner-only ledger link", async () => {
    // The Ledger tab is owner-only, so its link must never render for a
    // manager (never render a forbidden link) — neither in the payment-details
    // panel nor in the tab strip.
    const { attendeeId } = await createReservedAttendee(1500, {
      paymentId: "pi_deposit",
    });
    const overview = await awaitTestRequest(`/admin/attendees/${attendeeId}`, {
      cookie: await createTestManagerSession(),
    });
    const html = await expectHtmlResponse(overview, 200);
    expect(html).toContain("Balance outstanding");
    expect(html).not.toContain(`/admin/attendees/${attendeeId}/ledger`);
    expect(html).not.toContain("view ledger &amp; payment link");
  });
});
