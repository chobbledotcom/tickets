import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { settleAttendeeBalance } from "#db/attendees/balance.ts";
import { getDb } from "#db/client.ts";
import {
  expectHtml,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet, createTestManagerSession } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";

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
  const result = await attendeesApi.createAttendeeAtomic({
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
  const reservation = await attendeeStatuses.table.insert({
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
    // The headline summary opens with a prose block and the status name beside
    // its label (with the separating space).
    expect(html).toContain('class="prose"><h3>Reservation balance');
    expect(html).toContain("Status:</strong> Reserved");
    expect(html).toContain("Reservation deposit");
    expect(html).toContain("Balance outstanding");
    // The account statement (the "bits already there") renders alongside, with
    // its running-balance table's counterparty column.
    expect(html).toContain("<th>Other side</th>");
    // The customer payment link block: its prose heading, the copyable text
    // input carrying the signed link, and the quantity note.
    expect(html).toContain('class="prose"><h3>Customer payment link');
    expect(html).toContain('class="copyable" readonly type="text"');
    expect(html).toContain('class="muted small">Only items with a quantity');
    // The signed customer link points at the public pay page.
    expect(html).toContain("/pay/bal1.");
    // The history section is a prose pointer to the Activity tab (no log list).
    expect(html).toContain('class="prose"><h3>History');
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
        // The offline-collection guidance opens with its own prose block.
        'class="prose"><h3>Collect this balance directly',
        "no payment provider is connected",
      ],
      notContains: ["/pay/"],
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
    // The fully-paid note renders in its own prose block.
    expect(html).toContain('class="prose"><p>This booking is fully paid');
    // No payment link when nothing is outstanding.
    expect(html).not.toContain("/pay/bal1.");
  });

  test("lists only the no-provider reason for a non-reservation balance without a provider", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    // No status at all and no provider. Status no longer gates online balance
    // payment, so the only blocker left is the missing provider.
    const attendeeId = await owedAttendee(listing.id, null, 1500);
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/ledger`), {
      contains: [
        "Balance outstanding",
        "Collect this balance directly",
        "no payment provider is connected",
        // No status → an em-dash placeholder beside the status label.
        "Status:</strong> —",
      ],
      notContains: ["Reservation deposit", "/pay/"],
      status: 200,
    });
  });

  test("treats a single penny outstanding as a balance to collect, not fully paid", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    // Boundary guard: any positive balance (even £0.01) is outstanding, so the
    // panel offers to collect it rather than declaring the booking fully paid.
    const attendeeId = await owedAttendee(listing.id, null, 1);
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/ledger`), {
      contains: ["Collect this balance directly"],
      notContains: ["This booking is fully paid"],
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
      notContains: ["/pay/", "no payment provider is connected"],
    });
  });

  test("shows the customer pay link for a non-reservation status once a provider is connected", async () => {
    // Removing the reservation-only restriction: a named, non-reservation
    // status with a provider and a real line can now take a balance payment
    // online, so the customer link is offered — not the offline guidance.
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
    });
    const confirmed = await attendeeStatuses.table.insert({
      isReservation: false,
      name: "Confirmed",
      reservationAmount: "0",
    });
    const attendeeId = await owedAttendee(listing.id, confirmed.id, 1500, 0);
    await expectHtml(await adminGet(`/admin/attendees/${attendeeId}/ledger`), {
      contains: ["Balance outstanding", "/pay/bal1."],
      notContains: ["Collect this balance directly", "Reservation deposit"],
      status: 200,
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
    expect(html).toContain("View money changes and payment link");
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
