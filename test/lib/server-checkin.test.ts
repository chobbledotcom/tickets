import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { formatDateLabel } from "#shared/dates.ts";
import {
  adminGet,
  awaitTestRequest,
  bookAttendee,
  createDailyTestAttendee,
  createTestAttendeeWithToken,
  createTestListing,
  describeWithEnv,
  mockFormRequest,
  testCookie,
  testCsrfToken,
} from "#test-utils";

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

    test("shows empty date cell for standard listing when combined with daily listing", async () => {
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
      expect(body).toContain("<th>Date</th>");
      expect(body).toContain(formatDateLabel(date));
      // Standard listing attendee has no date - empty cell rendered
      expect(body).toContain("Alice");
    });

    test("renders empty email and phone for attendee without contact details", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const result = await bookAttendee(listing, {
        email: "",
        name: "NoContact",
      });
      if (!result.success) throw new Error("Failed to create attendee");

      const response = await adminGet(
        `/checkin/${result.attendees[0]!.ticket_token}`,
      );
      const body = await response.text();
      expect(body).toContain("NoContact");
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
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
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
        `/checkin/${token}?message=Cannot%20check%20in%20refunded%20tickets`,
      );
    });

    test("blocks check-out for refunded attendee", async () => {
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
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
        `/checkin/${token}?message=Cannot%20check%20in%20refunded%20tickets`,
      );
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
