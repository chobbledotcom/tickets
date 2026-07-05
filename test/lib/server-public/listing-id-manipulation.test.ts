// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectAttendeeCounts,
  expectReservedRedirectWithTokens,
  mockRequest,
  singleItem,
  submitMultiTicketForm,
  submitTicketForm,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > booking form listing_id manipulation",
  { db: true, triggers: true },
  () => {
    describe("booking form listing_id manipulation", () => {
      test("single-ticket form ignores injected listing_id field", async () => {
        const target = await createTestListing({
          maxAttendees: 50,
          name: "Target Listing",
        });
        const other = await createTestListing({
          maxAttendees: 50,
          name: "Other Listing",
        });

        // Submit form to target listing but inject other listing's id
        const response = await submitTicketForm(target.slug, {
          email: "mallory@example.com",
          items: singleItem(other.id, 1, 0),
          name: "Mallory",
        });
        // Booking succeeds (302 redirect to thank-you URL)
        expect(response.status).toBe(302);

        // Verify booking went to the URL's listing, not the injected one
        await expectAttendeeCounts([
          { count: 1, listingId: target.id },
          { count: 0, listingId: other.id },
        ]);
      });

      test("ticket form ignores quantity fields for listings not in URL", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Legit Listing 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Legit Listing 2",
        });
        const secret = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Secret Listing",
        });

        // Submit ticket form with only listing1+listing2 in URL
        // but inject quantity for the secret listing
        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            email: "mallory@example.com",
            name: "Mallory",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "0",
            [`quantity_${secret.id}`]: "3",
          },
        );
        expectReservedRedirectWithTokens(response);

        // Verify only listing1 was booked; secret listing was not
        await expectAttendeeCounts([
          { count: 1, listingId: listing1.id },
          { count: 0, listingId: listing2.id },
          { count: 0, listingId: secret.id },
        ]);
      });

      test("ticket URL cannot book inactive listings", async () => {
        const active = await createTestListing({
          maxAttendees: 50,
          name: "Active Listing",
        });
        const inactive = await createTestListing({
          maxAttendees: 50,
          name: "Inactive Listing",
        });
        await deactivateTestListing(inactive.id);

        // Try to load ticket page with inactive listing in URL
        const path = `/ticket/${active.slug}+${inactive.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const html = await getResponse.text();

        // Page should load but only show the active listing
        expect(html).toContain("Active Listing");
        expect(html).not.toContain("Inactive Listing");
      });
    });
  },
);
