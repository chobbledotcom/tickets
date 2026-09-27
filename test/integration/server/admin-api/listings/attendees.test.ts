import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import {
  bookableStartDates,
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

/** One attendee row as the endpoint answers with it. The values the tests
 * assert say what each case proves: contact fields are decrypted, the money
 * follows the ledger, and storage details stay on the server. */
type ApiAttendeeRow = {
  address: string;
  checked_in: boolean;
  created: string;
  date: string | null;
  email: string;
  id: number;
  kind: string;
  listing_id: number;
  name: string;
  payment_id: string;
  phone: string;
  price_paid: string;
  quantity: number;
  remaining_balance: number;
  special_instructions: string;
  ticket_token: string;
};

/** A listing's attendee rows, read through the endpoint under test with an
 * API key. Asserts the read succeeded, so a failing status stops the test. */
const listingAttendees = async (
  listingId: number,
): Promise<ApiAttendeeRow[]> => {
  const body = await assertJson<{ attendees: ApiAttendeeRow[] }>(
    apiRequest(`/api/admin/listings/${listingId}/attendees`),
    200,
  );
  return body.attendees;
};

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("GET /api/admin/listings/:listingId/attendees", () => {
    test("returns the listing's attendees with decrypted PII", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const other = await createTestListing({ maxAttendees: 10 });
      await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
        2,
        "+447700900123",
        "12 Main Street",
        "Vegetarian",
      );
      await createTestAttendeeDirect(
        listing.id,
        "Bob Smith",
        "bob@example.com",
      );
      await createTestAttendeeDirect(
        other.id,
        "Carol Other",
        "carol@example.com",
      );

      const rows = await listingAttendees(listing.id);
      expect(rows.length).toBe(2);
      // Newest booking first: Bob was booked after Jane.
      expect(rows[0]!.name).toBe("Bob Smith");
      expect(rows[0]!.email).toBe("bob@example.com");
      expect(rows[0]!.quantity).toBe(1);
      const jane = rows[1]!;
      expect(jane.name).toBe("Jane Doe");
      expect(jane.email).toBe("jane@example.com");
      expect(jane.phone).toBe("+447700900123");
      expect(jane.address).toBe("12 Main Street");
      expect(jane.special_instructions).toBe("Vegetarian");
      expect(jane.quantity).toBe(2);
      for (const row of rows) {
        // Only this listing's bookings: Carol booked the other listing.
        expect(row.listing_id).toBe(listing.id);
        expect(row.kind).toBe("attendee");
      }
    });

    test("reports the amount paid and the payment reference", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await bookAttendee(listing, {
        email: "buyer@example.com",
        name: "Buyer",
        paymentId: "pi_test_123",
        pricePaid: 2500,
      });

      const [row] = await listingAttendees(listing.id);
      expect(row!.payment_id).toBe("pi_test_123");
      expect(row!.price_paid).toBe("2500");
      expect(row!.remaining_balance).toBe(0);
    });

    test("hides the sealed PII blob and the token index", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await createTestAttendeeDirect(
        listing.id,
        "Hidden Storage",
        "hidden@example.com",
      );

      const rows = await listingAttendees(listing.id);
      expect(rows.length).toBe(1);
      // The row answers with its real keys, so absent fields can be asserted
      // by name: neither storage detail may cross the boundary.
      const keys = Object.keys(rows[0]!);
      expect(keys).not.toContain("pii_blob");
      expect(keys).not.toContain("ticket_token_index");
      expect(rows[0]!.ticket_token).not.toBe("");
    });

    test("returns one row per booking line, not per attendee", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const dates = await bookableStartDates(listing.id);
      const dayA = dates[0]!;
      const dayB = dates[1]!;
      const result = await attendeesApi.createAttendeeAtomic({
        bookings: [
          { date: dayA, listingId: listing.id },
          { date: dayB, listingId: listing.id },
        ],
        email: "both-days@example.com",
        name: "Both Days",
      });
      expect(result.success).toBe(true);

      const rows = await listingAttendees(listing.id);
      expect(rows.length).toBe(2);
      expect(new Set(rows.map((row) => row.id)).size).toBe(1);
      expect(new Set(rows.map((row) => row.date))).toEqual(
        new Set([dayA, dayB]),
      );
    });

    test("keeps a quantity-0 placeholder line", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await createTestAttendeeDirect(
        listing.id,
        "Waitlist Person",
        "waitlist@example.com",
        0,
      );

      const rows = await listingAttendees(listing.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.name).toBe("Waitlist Person");
      expect(rows[0]!.quantity).toBe(0);
    });

    test("returns 404 for a non-existent listing", async () => {
      await assertJson(
        apiRequest("/api/admin/listings/99999/attendees"),
        404,
        (body: { error: string }) => {
          expect(body.error).toBe("Listing not found");
        },
      );
    });

    test("returns 401 without auth", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await handleRequest(
        mockRequest(`/api/admin/listings/${listing.id}/attendees`),
      );

      expect(response.status).toBe(401);
    });

    test("returns an empty array for a listing with no bookings", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      expect(await listingAttendees(listing.id)).toEqual([]);
    });

    test("works with cookie+CSRF auth", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await createTestAttendeeDirect(
        listing.id,
        "Cookie Auth",
        "cookie@example.com",
      );
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await assertJson(
        handleRequest(
          requestAsSession(`/api/admin/listings/${listing.id}/attendees`, {
            cookie,
            csrfToken,
          }),
        ),
        200,
        (body: { attendees: ApiAttendeeRow[] }) => {
          expect(body.attendees[0]!.name).toBe("Cookie Auth");
        },
      );
    });
  });
});
