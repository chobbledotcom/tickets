import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import { postCheckin, setupCheckinTest } from "./helpers.ts";

describeWithEnv(
  "check-in and out (POST /checkin/:tokens)",
  { db: true },
  () => {
    describe("POST /checkin/:tokens", () => {
      test("checks in attendee with check_in=true and shows success", async () => {
        const { token, session } = await setupCheckinTest(
          "Eve",
          "eve@test.com",
        );
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
        const { token, session } = await setupCheckinTest(
          "Eve",
          "eve@test.com",
        );

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
        const { token, session } = await setupCheckinTest(
          "Eve",
          "eve@test.com",
        );

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
          "#db/attendees/tokens.ts"
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
          "#db/attendees/tokens.ts"
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
        // A package/order can mix a checkable member with a No check-in
        // (purchase_only) one on the same token; the token check-in must update
        // only the checkable row.
        const { attendeesApi } = await import("#db/attendees/api.ts");
        const { queryAll } = await import("#db/client.ts");
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
        const byListing = new Map(
          rows.map((r) => [r.listing_id, r.checked_in]),
        );
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
  },
);
