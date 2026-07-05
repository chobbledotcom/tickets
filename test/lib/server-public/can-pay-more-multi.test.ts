// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  createTestListing,
  describeWithEnv,
  expectCheckoutRedirect,
  expectFlash,
  mockRequest,
  setupStripe,
  submitMultiTicketForm,
} from "#test-utils";
import { payMoreListing } from "./can-pay-more-listing.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > can_pay_more (ticket)",
  { db: true, triggers: true },
  () => {
    describe("can_pay_more", () => {
      afterEach(() => {
        resetStripeClient();
      });

      test("GET ticket page shows pay-more inputs only for can_pay_more listings", async () => {
        const listing1 = await payMoreListing({
          name: "Pay More Multi",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Normal Multi",
          unitPrice: 1000,
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        const html = await response.text();
        expect(html).toContain(`name="custom_price_${listing1.id}"`);
        expect(html).not.toContain(`name="custom_price_${listing2.id}"`);
      });

      test("POST ticket with can_pay_more redirects to checkout", async () => {
        await setupStripe();
        const listing1 = await payMoreListing({
          maxQuantity: 5,
          name: "Pay More A",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Normal B",
          unitPrice: 1000,
        });
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`custom_price_${listing1.id}`]: "15.00",
        });
        expectCheckoutRedirect(response);
      });

      test("POST ticket rejects custom_price below minimum", async () => {
        const listing1 = await payMoreListing({
          maxQuantity: 5,
          name: "Pay More Reject",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Normal Reject",
          unitPrice: 1000,
        });
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`custom_price_${listing1.id}`]: "2.00",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("minimum"), false);
      });

      test("POST ticket rejects custom_price above maximum", async () => {
        const listing1 = await payMoreListing({
          maxQuantity: 5,
          name: "Pay More Max Reject",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Normal Max Reject",
          unitPrice: 1000,
        });
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`custom_price_${listing1.id}`]: "200.00",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("maximum"), false);
      });

      test("POST ticket skips price check for can_pay_more listing with qty 0", async () => {
        await setupStripe();
        const listing1 = await payMoreListing({
          maxQuantity: 5,
          name: "Pay More Skip",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Normal Skip",
          unitPrice: 1000,
        });
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "0",
          [`quantity_${listing2.id}`]: "1",
        });
        expectCheckoutRedirect(response);
      });

      test("POST ticket free can_pay_more with custom price redirects to checkout", async () => {
        await setupStripe();
        const listing1 = await payMoreListing({
          maxQuantity: 5,
          name: "Free Donate",
          unitPrice: 0,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Normal Paid",
          unitPrice: 1000,
        });
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`custom_price_${listing1.id}`]: "5.00",
        });
        expectCheckoutRedirect(response);
      });

      test("POST ticket free can_pay_more with zero price still processes paid listing", async () => {
        await setupStripe();
        const listing1 = await payMoreListing({
          maxQuantity: 5,
          name: "Free No Donate",
          unitPrice: 0,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Normal Paid 2",
          unitPrice: 1000,
        });
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`custom_price_${listing1.id}`]: "0",
        });
        expectCheckoutRedirect(response);
      });
    });
  },
);
