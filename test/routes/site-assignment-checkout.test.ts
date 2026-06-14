import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  createTestListing,
  describeWithEnv,
  extractCsrfToken,
  mockFormRequest,
  mockRequest,
  setupStripe,
} from "#test-utils";

describeWithEnv(
  "routes > site assignment checkout validation",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

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

        const mockCreate = stub(
          stripePaymentProvider,
          "createCheckoutSession",
          () =>
            Promise.resolve({
              checkoutUrl: "https://checkout.stripe.com/should-not-run",
              sessionId: "cs_should_not_run",
            }),
        );

        try {
          const response = await handleRequest(
            mockFormRequest(`/ticket/${listing.slug}`, {
              csrf_token: csrf,
              email: "site@example.com",
              name: "Site Buyer",
              [`quantity_${listing.id}`]: "1",
            }),
          );

          expect(response.status).toBe(302);
          expect(mockCreate.calls.length).toBe(0);
        } finally {
          mockCreate.restore();
        }
      });
    });
  },
);
