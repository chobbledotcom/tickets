import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { settleAttendeeBalance } from "#db/attendees/balance.ts";
import { getDb } from "#db/client.ts";
import { handleRequest } from "#routes";
import { routeBalance } from "#routes/public/balance.ts";
import {
  createNonReservation,
  createReserved,
  expectRecap,
  getPayPage,
  settle,
} from "#test/integration/balance-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookedAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describeWithEnv("server (public balance page) > GET", { db: true }, () => {
  test("GET shows the recap and balance due for a reserved attendee", async () => {
    const html = await getPayPage(await createReserved(1500));
    expectRecap(html);
    // No PII (the booker's name) is shown.
    expect(html).not.toContain("Guest");
  });

  test("GET shows a settled message once the balance is cleared", async () => {
    const attendeeId = await createReserved(1500);
    await settleAttendeeBalance(attendeeId, 1500, settle());
    expect(await getPayPage(attendeeId)).toContain("Nothing to pay");
  });

  test("GET rejects an invalid token", async () => {
    const response = await handleRequest(mockRequest("/pay/bal1.bogus.bogus"));
    const html = await response.text();
    expect(html).toContain("not valid");
  });

  test("GET rejects a validly-signed token for a missing attendee", async () => {
    // The token verifies, but no attendee row matches, so the balance state is
    // null. The handler must short-circuit to the not-valid page rather than
    // dereference the absent state.
    expect(await getPayPage(999_999)).toContain("not valid");
  });

  test("GET shows the recap for a non-reservation attendee with an outstanding balance", async () => {
    // Removing the reservation-only restriction: any attendee who still owes
    // money can pay it online, whatever status the booking sits in.
    const html = await getPayPage(await createNonReservation(1500));
    expectRecap(html);
    expect(html).not.toContain("Nothing to pay");
  });

  test("GET shows the recap when just 1 is still owed", async () => {
    // Boundary guard: only a non-positive balance is 'settled', so a single
    // penny still outstanding shows the pay page rather than "Nothing to pay".
    const html = await getPayPage(await createNonReservation(1));
    expectRecap(html);
    expect(html).not.toContain("Nothing to pay");
  });

  test("GET refuses a reserved balance whose only line is no-quantity", async () => {
    const attendeeId = await createReserved(1500);
    // Turn the only line into a no-quantity sentinel: nothing real to pay into.
    await getDb().execute({
      args: [attendeeId],
      sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
    });
    // An honest "no tickets to pay for" message, not a misleading "link invalid".
    expect(await getPayPage(attendeeId)).toContain("no tickets to pay for");
  });

  test("GET hides concealed package members behind the package name", async () => {
    // A mixed booking keeps the standalone line's own name while the tagged
    // rows collapse behind the package, matching the ticket and email recap.
    const group = await createHiddenPackageGroup("Mystery Box");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Secret Contents",
      unitPrice: 1000,
    });
    const plain = await createTestListing({
      maxAttendees: 10,
      name: "Workshop Ticket",
      unitPrice: 1000,
    });
    const attendee = bookedAttendee(
      await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: member.id, packageGroupId: group.id, quantity: 1 },
          { listingId: plain.id, quantity: 2 },
        ],
        email: "balance@example.com",
        name: "Balance Buyer",
        remainingBalance: 3000,
      }),
    );
    await postListingSale({
      amountPaid: 0,
      attendeeId: attendee.id,
      gross: 1000,
      listingId: member.id,
    });
    await postListingSale({
      amountPaid: 0,
      attendeeId: attendee.id,
      gross: 2000,
      listingId: plain.id,
    });

    const html = await getPayPage(attendee.id);

    expect(html).not.toContain("Secret Contents");
    expect(html).toContain("Mystery Box");
    expect(html).toContain("Workshop Ticket");
    expect(html).toContain("Balance due");
  });

  test("GET uses the generic package label when the package row is gone", async () => {
    // A deleted concealed package still conceals its members: no name recovery.
    const group = await createHiddenPackageGroup("Vanished Bundle");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Secret Remnant",
      unitPrice: 1000,
    });
    const attendee = bookedAttendee(
      await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: member.id, packageGroupId: group.id, quantity: 1 },
        ],
        email: "gone@example.com",
        name: "Gone Buyer",
        remainingBalance: 1000,
      }),
    );
    await postListingSale({
      amountPaid: 0,
      attendeeId: attendee.id,
      gross: 1000,
      listingId: member.id,
    });
    // Hard-delete the group: a pay-page read must not recover member names
    // from an absent package row.
    await getDb().execute("DELETE FROM group_listings WHERE group_id = ?", [
      group.id,
    ]);
    await getDb().execute("DELETE FROM groups WHERE id = ?", [group.id]);

    const html = await getPayPage(attendee.id);

    expect(html).not.toContain("Secret Remnant");
    expect(html).toContain("Package");
  });

  test("non-matching /pay requests fall through", async () => {
    // The bare prefix and an unsupported method are not handled here (→ not 200).
    expect((await handleRequest(mockRequest("/pay"))).status).not.toBe(200);
    expect((await handleRequest(mockRequest("/pay/"))).status).not.toBe(200);
    const del = await handleRequest(
      new Request("http://localhost/pay/bal1.x.y", { method: "DELETE" }),
    );
    expect(del.status).not.toBe(200);
  });

  test("routeBalance delegates (returns null) for a non-/pay path or unsupported method", async () => {
    // The dispatcher must return exactly null (not undefined) to delegate: a
    // path outside /pay/, and an unsupported method on a /pay/ path.
    const request = mockRequest("/pay/bal1.x.y");
    expect(await routeBalance(request, "/other", "GET")).toBe(null);
    expect(await routeBalance(request, "/pay/bal1.x.y", "DELETE")).toBe(null);
  });
});
