/**
 * Tests for the token lookup contracts on GET /t/:tokens and /t/:token/svg
 *
 * Sits beside the story `@story:attendees.the-ticket-a-customer-holds`: the
 * story owns what a holder sees on their ticket, so these own the answers a
 * page cannot show — the status codes for a code the site does not know, the
 * refusal of a method that is not GET, the caching headers on the QR image,
 * and the blind index that makes a token findable without decrypting it.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendee,
  createTestAttendeeWithToken,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv("ticket view (/t/:tokens)", { db: true }, () => {
  describe("a code the site cannot resolve", () => {
    test("answers 404 for a token nothing was booked under", async () => {
      const response = await awaitTestRequest("/t/nonexistent-token");
      expect(response.status).toBe(404);
    });

    test("answers 404 when the path carries no token at all", async () => {
      const response = await awaitTestRequest("/t/");
      expect(response.status).toBe(404);
    });

    test("answers 404 for a QR image whose token nothing was booked under", async () => {
      const response = await awaitTestRequest("/t/nonexistent-token/svg");
      expect(response.status).toBe(404);
    });
  });

  test("claims no route for a method other than GET", async () => {
    const { routeTicketView } = await import("#routes/tickets/index.ts");
    const request = new Request("http://localhost/t/some-token", {
      method: "POST",
    });
    const result = await routeTicketView(request, "/t/some-token", "POST");
    expect(result).toBeNull();
  });

  test("gives every attendee its own blind token index", async () => {
    // The index is what a lookup matches on, so two attendees sharing one
    // would hand a stranger somebody else's ticket, and an empty one would
    // make a ticket unfindable.
    const listing = await createTestListing({ maxAttendees: 10 });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Frank",
      "frank@test.com",
    );
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Grace",
      "grace@test.com",
    );
    const attendees = await getAttendeesRaw(listing.id);

    expect(attendees[0]!.ticket_token_index).not.toBe("");
    expect(attendees[1]!.ticket_token_index).not.toBe("");
    expect(attendees[0]!.ticket_token_index).not.toBe(
      attendees[1]!.ticket_token_index,
    );
  });

  describe("the QR image at /t/:token/svg", () => {
    test("serves an SVG that may be cached forever", async () => {
      // A ticket's code never changes, so the image is immutable and public:
      // the CDN serves it instead of the app on every scan.
      const { token } = await createTestAttendeeWithToken(
        "Eve",
        "eve@test.com",
      );

      const response = await awaitTestRequest(`/t/${token}/svg`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("cache-control")).toContain("public");

      const body = await response.text();
      expect(body).toContain("<svg");
      expect(body).toContain("</svg>");
    });
  });
});
