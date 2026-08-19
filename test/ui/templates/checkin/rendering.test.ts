import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatDateLabel } from "#shared/dates.ts";
import { tableRowContaining } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestAttendee,
  createMultiBookingAttendee,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie } from "#test-utils/session.ts";
import { setupCheckinTest } from "./helpers.ts";

describeWithEnv("check-in page (GET /checkin/:tokens)", { db: true }, () => {
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
      const { getDb } = await import("#db/client.ts");
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
      expect(tableRowContaining(body, "Zara")).toContain(formatDateLabel(date));
      expect(tableRowContaining(body, "Alice")).not.toContain(
        formatDateLabel(date),
      );
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
      expect(tableRowContaining(body, "WithContact")).toContain(
        '<td>with@test.com</td><td><a href="tel:+44712345678">0712345678</a></td>',
      );
      expect(tableRowContaining(body, "NoContact")).toContain(
        "<td></td><td></td>",
      );
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
});
