// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { payMoreListing } from "#test/integration/server/public/can-pay-more-listing.ts";
import { expectCheckoutRedirect, expectFlash } from "#test-utils/assertions.ts";
import { submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > can_pay_more (ticket)",
  { db: true, triggers: true },
  () => {
    describe("can_pay_more", () => {
      /** A can_pay_more listing1 alongside a plain listing2, both purchasable
       * up to 5 — the two-listing setup shared by every ticket-level
       * can_pay_more POST test below. */
      const payMoreMultiScenario = async (
        listing1Name: string,
        listing1UnitPrice: number,
        listing2Name: string,
      ) => {
        const listing1 = await payMoreListing({
          maxQuantity: 5,
          name: listing1Name,
          unitPrice: listing1UnitPrice,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: listing2Name,
          unitPrice: 1000,
        });
        return {
          listing1,
          listing2,
          slug: `${listing1.slug}+${listing2.slug}`,
        };
      };

      /** Submits the joint ticket form for a `payMoreMultiScenario` pair,
       * booking one of each and applying `customPrice` (when given) as
       * listing1's `custom_price` — the shared POST shape behind every
       * assertion below. */
      const submitPayMoreMulti = (
        slug: string,
        listing1Id: number,
        listing2Id: number,
        listing1Quantity: string,
        customPrice?: string,
      ): Promise<Response> =>
        submitMultiTicketForm(slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1Id}`]: listing1Quantity,
          [`quantity_${listing2Id}`]: "1",
          ...(customPrice === undefined
            ? {}
            : { [`custom_price_${listing1Id}`]: customPrice }),
        });

      test("GET ticket page shows pay-more inputs only for can_pay_more listings", async () => {
        const { listing1, listing2 } = await payMoreMultiScenario(
          "Pay More Multi",
          500,
          "Normal Multi",
        );
        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        const html = await response.text();
        expect(html).toContain(`name="custom_price_${listing1.id}"`);
        expect(html).not.toContain(`name="custom_price_${listing2.id}"`);
      });

      test("POST ticket with can_pay_more redirects to checkout", async () => {
        await setupStripe();
        const { listing1, listing2, slug } = await payMoreMultiScenario(
          "Pay More A",
          500,
          "Normal B",
        );
        const response = await submitPayMoreMulti(
          slug,
          listing1.id,
          listing2.id,
          "1",
          "15.00",
        );
        expectCheckoutRedirect(response);
      });

      test("POST ticket rejects custom_price below minimum", async () => {
        const { listing1, listing2, slug } = await payMoreMultiScenario(
          "Pay More Reject",
          500,
          "Normal Reject",
        );
        const response = await submitPayMoreMulti(
          slug,
          listing1.id,
          listing2.id,
          "1",
          "2.00",
        );
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("minimum"), false);
      });

      test("POST ticket rejects custom_price above maximum", async () => {
        const { listing1, listing2, slug } = await payMoreMultiScenario(
          "Pay More Max Reject",
          500,
          "Normal Max Reject",
        );
        const response = await submitPayMoreMulti(
          slug,
          listing1.id,
          listing2.id,
          "1",
          "200.00",
        );
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("maximum"), false);
      });

      test("POST ticket skips price check for can_pay_more listing with qty 0", async () => {
        await setupStripe();
        const { listing1, listing2, slug } = await payMoreMultiScenario(
          "Pay More Skip",
          500,
          "Normal Skip",
        );
        const response = await submitPayMoreMulti(
          slug,
          listing1.id,
          listing2.id,
          "0",
        );
        expectCheckoutRedirect(response);
      });

      test("POST ticket free can_pay_more with custom price redirects to checkout", async () => {
        await setupStripe();
        const { listing1, listing2, slug } = await payMoreMultiScenario(
          "Free Donate",
          0,
          "Normal Paid",
        );
        const response = await submitPayMoreMulti(
          slug,
          listing1.id,
          listing2.id,
          "1",
          "5.00",
        );
        expectCheckoutRedirect(response);
      });

      test("POST ticket free can_pay_more with zero price still processes paid listing", async () => {
        await setupStripe();
        const { listing1, listing2, slug } = await payMoreMultiScenario(
          "Free No Donate",
          0,
          "Normal Paid 2",
        );
        const response = await submitPayMoreMulti(
          slug,
          listing1.id,
          listing2.id,
          "1",
          "0",
        );
        expectCheckoutRedirect(response);
      });
    });
  },
);
