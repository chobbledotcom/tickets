import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { postExpectingNoCheckout } from "#test/integration/routes/_shared-checkout.ts";
import { extractCsrfToken } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv(
  "routes > site assignment checkout validation",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    describe("POST /ticket/:slug", () => {
      test("blocks checkout when a site-assignment listing has no renewal tier", async () => {
        await setupStripe();
        const listing = await createTestListing({
          assignBuiltSite: true,
          initialSiteMonths: 3,
          maxAttendees: 100,
          name: "Site Ticket",
          unitPrice: 500,
        });

        const csrf = extractCsrfToken(
          await (
            await handleRequest(mockRequest(`/ticket/${listing.slug}`))
          ).text(),
        )!;

        const { response, checkoutCalls } = await postExpectingNoCheckout(
          mockFormRequest(`/ticket/${listing.slug}`, {
            csrf_token: csrf,
            email: "site@example.com",
            name: "Site Buyer",
            [`quantity_${listing.id}`]: "1",
          }),
        );

        expect(response.status).toBe(302);
        expect(checkoutCalls).toBe(0);
      });
    });
  },
);
