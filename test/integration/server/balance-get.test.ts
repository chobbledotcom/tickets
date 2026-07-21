import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { routeBalance } from "#routes/public/balance.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { getDb } from "#shared/db/client.ts";
import {
  createNonReservation,
  createReserved,
  expectRecap,
  getPayPage,
  settle,
} from "#test/lib/server-balance-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
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
