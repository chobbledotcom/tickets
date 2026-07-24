import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { formatDateLabel } from "#shared/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestAttendee,
  createMultiBookingAttendee,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";

/** Finds the `<tr>` row containing needle and returns its complete HTML. */
const rowFor = (html: string, needle: string): string => {
  const start = html.indexOf("<tr", 0);
  for (let i = start; i >= 0; i = html.indexOf("<tr", i + 1)) {
    const end = html.indexOf("</tr>", i);
    if (end === -1) break;
    const row = html.slice(i, end + 5);
    if (row.includes(needle)) return row;
  }
  throw new Error(`No <tr> row containing "${needle}" found in HTML`);
};

/** Create attendee + login, returning token + session for check-in tests */
const setupCheckinTest = async (
  name: string,
  email: string,
  listingOverrides = {},
  quantity = 1,
  phone = "",
) => {
  const { listing, token } = await createTestAttendeeWithToken(
    name,
    email,
    listingOverrides,
    quantity,
    phone,
  );
  return {
    listing,
    session: { cookie: await testCookie(), csrfToken: await testCsrfToken() },
    token,
  };
};

/** Submit a check-in or check-out POST for a given token and session */
const postCheckin = (
  token: string,
  session: { cookie: string; csrfToken: string },
  checkIn: "true" | "false",
) =>
  handleRequest(
    mockFormRequest(
      `/checkin/${token}`,
      { check_in: checkIn, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );

describeWithEnv("check-in (/checkin/:tokens)", { db: true }, () => {
  describe("GET /checkin/:tokens (unauthenticated)", () => {
    test("shows public check-in message for unauthenticated users", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );

      const response = await awaitTestRequest(`/checkin/${token}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("Check-in");
      expect(body).toContain("show this QR code");
    });

    test("returns 404 for invalid token", async () => {
      const response = await awaitTestRequest("/checkin/bad-token");
      expect(response.status).toBe(404);
    });
  });

  describe("GET /checkin/:tokens (authenticated admin)", () => {
    test("shows current status without auto-checking-in", async () => {
      const { token, session } = await setupCheckinTest("Bob", "bob@test.com");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain("Check in");
      expect(body).toContain("Check In All");
      expect(body).not.toContain('class="success"');
    });

    test("keeps one row per booking line, each with its own listing's check-in button", async () => {
      const first = await createTestListing({
        maxAttendees: 10,
        name: "First Listing",
      });
      const second = await createTestListing({
        maxAttendees: 10,
        name: "Second Listing",
      });
      const attendee = await createMultiBookingAttendee(
        "Multi",
        "multi@test.com",
        [{ listingId: first.id }, { listingId: second.id }],
      );
      const cookie = await testCookie();

      const response = await awaitTestRequest(
        `/checkin/${attendee.ticket_token}`,
        { cookie },
      );
      const body = await response.text();
      // The bookings stay separate rows so each listing checks in on its own.
      expect(body).toContain(
        `/admin/listing/${first.id}/attendee/${attendee.id}/checkin`,
      );
      expect(body).toContain(
        `/admin/listing/${second.id}/attendee/${attendee.id}/checkin`,
      );
    });

    test("shows attendee contact details in admin view", async () => {
      const { token, session } = await setupCheckinTest(
        "Bob",
        "bob@test.com",
        { fields: "email,phone" },
        1,
        "555-1234",
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain("Bob");
      expect(body).toContain("bob@test.com");
      expect(body).toContain("555-1234");
    });

    test("shows multiple attendees from different listings", async () => {
      const { listing: listingA, token: tokenA } =
        await createTestAttendeeWithToken("Carol", "carol@test.com");
      const { listing: listingB, token: tokenB } =
        await createTestAttendeeWithToken("Carol", "carol@test.com");

      const response = await adminGet(`/checkin/${tokenA}+${tokenB}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain(listingA.name);
      expect(body).toContain(listingB.name);
    });

    test("returns 404 for invalid tokens when authenticated", async () => {
      const response = await adminGet("/checkin/bad-token");
      expect(response.status).toBe(404);
    });

    test("returns 404 for orphaned attendee with no listing links", async () => {
      const { listing, token } = await setupCheckinTest(
        "Orphan",
        "orphan@test.com",
      );
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute({
        args: [listing.id],
        sql: "DELETE FROM listing_attendees WHERE listing_id = ?",
      });
      const response = await adminGet(`/checkin/${token}`);
      expect(response.status).toBe(404);
    });

    test("shows listing name and quantity in admin view", async () => {
      const { listing, token, session } = await setupCheckinTest(
        "Dave",
        "dave@test.com",
        { maxQuantity: 5 },
        3,
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(listing.name);
      expect(body).toContain("3");
    });

    test("links listing name to admin listing page", async () => {
      const { listing, token, session } = await setupCheckinTest(
        "Fay",
        "fay@test.com",
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain(`href="/admin/listing/${listing.id}"`);
    });

    test("shows green bulk check-in button when not checked in", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).toContain('class="bulk-checkin"');
      expect(body).toContain("Check In All");
      expect(body).toContain('value="true"');
    });

    test("displays booked date for daily listing in admin view", async () => {
      const date = "2026-02-15";
      const { token } = await createDailyTestAttendee(
        "Zara",
        "zara@test.com",
        date,
      );

      const response = await adminGet(`/checkin/${token}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).toContain(formatDateLabel(date));
      expect(body).toContain("<th>Date</th>");
    });

    test("shows the Date column when a daily listing attendee is combined with a standard one", async () => {
      const date = "2026-02-15";
      const { token: tokenA } = await createDailyTestAttendee(
        "Zara",
        "zara@test.com",
        date,
      );
      const { token: tokenB } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );

      const response = await adminGet(`/checkin/${tokenA}+${tokenB}`);
      const body = await response.text();
      // The column header renders because at least one attendee in the bundle
      // has a date. Zara's row shows the formatted date label; Alice's row
      // shows an empty cell instead. The negative case — column hidden when
      // no attendee has a date — is covered by the test below.
      expect(body).toContain("<th>Date</th>");
      expect(rowFor(body, "Zara")).toContain(formatDateLabel(date));
      expect(rowFor(body, "Alice")).not.toContain(formatDateLabel(date));
    });

    test("renders an empty cell for an attendee with no email when another attendee has one", async () => {
      // The email and phone columns only render when at least one attendee
      // in the bundle has the field. Mix one attendee with contact details
      // and one without so the columns render, then check each attendee's own
      // row for the right cell values.
      const listing = await createTestListing({ maxAttendees: 10 });
      const withContact = await bookAttendee(listing, {
        email: "with@test.com",
        name: "WithContact",
        phone: "0712345678",
      });
      if (!withContact.success) throw new Error("Failed to create attendee");
      const withoutContact = await bookAttendee(listing, {
        email: "",
        name: "NoContact",
      });
      if (!withoutContact.success) throw new Error("Failed to create attendee");

      const response = await adminGet(
        `/checkin/${withContact.attendees[0]!.ticket_token}+${withoutContact.attendees[0]!.ticket_token}`,
      );
      const body = await response.text();
      // Column headers render because at least one attendee has each field.
      expect(body).toContain("<th>Email</th>");
      expect(body).toContain("<th>Phone</th>");
      // The contact-bearing attendee's row shows the values.
      expect(rowFor(body, "WithContact")).toContain("with@test.com");
      expect(rowFor(body, "WithContact")).toContain("0712345678");
      // The no-contact attendee's row shows empty cells for those columns.
      expect(rowFor(body, "NoContact")).toContain("<td></td>");
      expect(rowFor(body, "NoContact")).not.toContain("with@test.com");
      expect(rowFor(body, "NoContact")).not.toContain("0712345678");
    });

    test("does not show date column for standard listing in admin view", async () => {
      const { token, session } = await setupCheckinTest(
        "Alice",
        "alice@test.com",
      );
      const response = await awaitTestRequest(`/checkin/${token}`, {
        cookie: session.cookie,
      });
      const body = await response.text();
      expect(body).not.toContain("<th>Date</th>");
    });
  });

  describe("POST /checkin/:tokens", () => {
    test("checks in attendee with check_in=true and shows success", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");
      const response = await postCheckin(token, session, "true");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/checkin/${token}?message=Checked%20in%201%20ticket`,
      );

      // Follow redirect and verify checked-in state
      const viewResponse = await awaitTestRequest(
        `/checkin/${token}?message=Checked%20in%201%20ticket`,
        {
          cookie: session.cookie,
        },
      );
      const body = await viewResponse.text();
      expect(body).toContain("Check out");
      expect(body).toContain('class="success"');
      expect(body).toContain("Checked in 1 ticket");
      expect(body).toContain('class="bulk-checkout"');
      expect(body).toContain("Check Out All");
      expect(body).toContain('value="false"');
    });

    test("checks out attendee with check_in=false and shows success", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");

      // First check in
      await postCheckin(token, session, "true");

      // Then check out
      const response = await postCheckin(token, session, "false");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/checkin/${token}?message=Checked%20out`,
      );

      // Follow redirect and verify checked-out state
      const viewResponse = await awaitTestRequest(
        `/checkin/${token}?message=Checked%20out`,
        {
          cookie: session.cookie,
        },
      );
      const body = await viewResponse.text();
      expect(body).toContain("Check in");
      expect(body).toContain("Checked out");
    });

    test("duplicate check-in shows already checked in message", async () => {
      const { token, session } = await setupCheckinTest("Eve", "eve@test.com");

      // Check in twice (simulates two tabs)
      await postCheckin(token, session, "true");
      const response = await postCheckin(token, session, "true");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/checkin/${token}?message=Already%20checked%20in%201%20ticket`,
      );

      // Follow redirect and verify still checked in
      const viewResponse = await awaitTestRequest(
        `/checkin/${token}?message=Already%20checked%20in%201%20ticket`,
        { cookie: session.cookie },
      );
      const body = await viewResponse.text();
      expect(body).toContain("Check out");
      expect(body).toContain("Already checked in 1 ticket");
    });

    test("check-in with quantity > 1 shows plural ticket count", async () => {
      const { token, session } = await setupCheckinTest(
        "Hal",
        "hal@test.com",
        { maxQuantity: 5 },
        3,
      );

      const response = await postCheckin(token, session, "true");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/checkin/${token}?message=Checked%20in%203%20tickets`,
      );
    });

    test("blocks check-in for refunded attendee", async () => {
      const { getAttendeesByTokens } = await import(
        "#shared/db/attendees/tokens.ts"
      );
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const { listing, token, session } = await setupCheckinTest(
        "Refund",
        "refund@test.com",
      );

      const attendees = await getAttendeesByTokens([token]);
      await postAttendeeRefund({
        attendeeId: attendees[0]!.id,
        listingId: listing.id,
      });

      const response = await postCheckin(token, session, "true");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/checkin/${token}?message=No%20tickets%20on%20this%20token%20can%20be%20checked%20in`,
      );
    });

    test("blocks check-out for refunded attendee", async () => {
      const { getAttendeesByTokens } = await import(
        "#shared/db/attendees/tokens.ts"
      );
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const { listing, token, session } = await setupCheckinTest(
        "Refund2",
        "refund2@test.com",
      );

      const attendees = await getAttendeesByTokens([token]);
      await postAttendeeRefund({
        attendeeId: attendees[0]!.id,
        listingId: listing.id,
      });

      const response = await postCheckin(token, session, "false");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/checkin/${token}?message=No%20tickets%20on%20this%20token%20can%20be%20checked%20in`,
      );
    });

    test("a shared token checks in the normal row but never a purchase-only one", async () => {
      // A package/order can mix a checkable member with a No Check-In
      // (purchase_only) one on the same token; the token check-in must update
      // only the checkable row.
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
      const { queryAll } = await import("#shared/db/client.ts");
      const normal = await createTestListing({ name: "Entry Pass" });
      const merch = await createTestListing({
        name: "Merch Add-on",
        purchaseOnly: true,
      });
      const result = await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: normal.id, quantity: 1 },
          { listingId: merch.id, quantity: 1 },
        ],
        email: "mixed@test.com",
        name: "Mixed Buyer",
      });
      if (!result.success) throw new Error("booking failed");
      const token = result.attendees[0]!.ticket_token;
      const session = {
        cookie: await testCookie(),
        csrfToken: await testCsrfToken(),
      };

      const response = await postCheckin(token, session, "true");
      expect(response.status).toBe(302);
      // Only the checkable ticket is counted and updated.
      expect(response.headers.get("location")).toBe(
        `/checkin/${token}?message=Checked%20in%201%20ticket`,
      );
      const rows = await queryAll<{ listing_id: number; checked_in: number }>(
        "SELECT listing_id, checked_in FROM listing_attendees WHERE attendee_id = ?",
        [result.attendees[0]!.id],
      );
      const byListing = new Map(rows.map((r) => [r.listing_id, r.checked_in]));
      expect(byListing.get(normal.id)).toBe(1);
      expect(byListing.get(merch.id)).toBe(0);
    });

    test("redirects to admin for unauthenticated POST", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Frank",
        "frank@test.com",
      );
      const response = await handleRequest(
        mockFormRequest(`/checkin/${token}`, { csrf_token: "fake" }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/admin");
    });

    test("returns 403 for invalid CSRF token", async () => {
      const { token, session } = await setupCheckinTest(
        "Grace",
        "grace@test.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/checkin/${token}`,
          { csrf_token: "wrong-token" },
          session.cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("returns 404 for invalid tokens on POST", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/checkin/bad-token",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("route matching", () => {
    test("returns null for non-matching paths", async () => {
      const { routeCheckin } = await import("#routes/checkin.ts");
      const request = new Request("http://localhost/other");
      const result = await routeCheckin(request, "/other", "GET");
      expect(result).toBeNull();
    });

    test("returns null for unsupported methods", async () => {
      const { routeCheckin } = await import("#routes/checkin.ts");
      const request = new Request("http://localhost/checkin/tok", {
        method: "PUT",
      });
      const result = await routeCheckin(request, "/checkin/tok", "PUT");
      expect(result).toBeNull();
    });
  });
});
