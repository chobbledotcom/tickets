// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  expectCheckoutRedirect,
  expectHtmlResponse,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import {
  bookOneEachViaTicketForm,
  expectBookOneEachRejected,
  submitMultiTicketForm,
  submitTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket paid flow edge cases",
  { db: true, triggers: true },
  () => {
    describe("routes/public.ts (ticket paid flow)", () => {
      test("ticket paid flow redirects to Stripe checkout", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Paid Flow 1",
          unitPrice: 1000,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Paid Flow 2",
          unitPrice: 500,
        });

        const response = await bookOneEachViaTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          listing1.id,
          listing2.id,
        );
        // Should redirect to Stripe checkout
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain("checkout.stripe.com");
      });

      test("ticket paid flow shows error when session creation fails", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Nourl 1",
          unitPrice: 1000,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Nourl 2",
          unitPrice: 500,
        });

        // Mock createCheckoutSession to return no URL
        const { stripePaymentProvider } = await import(
          "#shared/stripe-provider.ts"
        );
        const mockCreate = stub(
          stripePaymentProvider,
          "createCheckoutSession",
          () => Promise.resolve(null),
        );

        try {
          await expectBookOneEachRejected(
            `${listing1.slug}+${listing2.slug}`,
            listing1.id,
            listing2.id,
            "Failed to create payment session",
          );
        } finally {
          mockCreate.restore();
        }
      });

      test("ticket paid flow shows validation error from checkout session", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Valerr 1",
          unitPrice: 1000,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Valerr 2",
          unitPrice: 500,
        });

        const { stripePaymentProvider } = await import(
          "#shared/stripe-provider.ts"
        );
        const mockCreate = stub(
          stripePaymentProvider,
          "createCheckoutSession",
          () => Promise.resolve({ error: "Invalid phone number format" }),
        );

        try {
          await expectBookOneEachRejected(
            `${listing1.slug}+${listing2.slug}`,
            listing1.id,
            listing2.id,
            "Invalid phone number format",
          );
        } finally {
          mockCreate.restore();
        }
      });

      test("skips sold-out listings in quantity parsing", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 1,
          name: "Multi Soldout 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Soldout 2",
        });

        // Fill listing1 to capacity
        await bookAttendee(listing1, {
          email: "first@example.com",
          name: "First",
          quantity: 1,
        });

        // Submit with qty for both listings, but listing1 should be skipped as sold out
        const response = await bookOneEachViaTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          listing1.id,
          listing2.id,
        );
        // Should succeed for listing2 only
        expectReservedRedirectWithTokens(response);
      });
    });

    describe("routes/public.ts (ticket paid availability check fails)", () => {
      test("returns error when paid ticket availability check fails", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Avail Race 1",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Avail Race 2",
          unitPrice: 1000,
        });

        // Mock checkBatchAvailability via attendeesApi to return false,
        // simulating a race condition where listing sells out between page load and check
        const { attendeesApi } = await import("#db/attendees/api.ts");
        const mockBatch = stub(attendeesApi, "checkBatchAvailability", () =>
          Promise.resolve(false),
        );

        try {
          await expectBookOneEachRejected(
            `${listing1.slug}+${listing2.slug}`,
            listing1.id,
            listing2.id,
            "some tickets are no longer available",
          );
        } finally {
          mockBatch.restore();
        }
      });
    });

    describe("iframe checkout popup (Stripe cannot run in iframes)", () => {
      test("returns popup page instead of redirect for single-ticket paid listing in iframe", async () => {
        await setupStripe();
        const listing = await createTestListing({
          maxAttendees: 50,
          name: "Iframe Paid Single",
          unitPrice: 1000,
        });

        const response = await submitMultiTicketForm(
          `${listing.slug}?iframe=true`,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing.id}`]: "1",
          },
        );

        await expectHtmlResponse(
          response,
          200,
          "data-checkout-popup",
          "Pay Now",
          'target="_blank"',
        );
      });

      test("returns 302 redirect for single-ticket paid listing without iframe", async () => {
        await setupStripe();
        const listing = await createTestListing({
          maxAttendees: 50,
          name: "Non-iframe Paid Single",
          unitPrice: 1000,
        });

        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
        });

        expectCheckoutRedirect(response);
      });

      test("returns popup page for ticket paid listing in iframe", async () => {
        await setupStripe();
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Iframe Multi 1",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Iframe Multi 2",
          unitPrice: 1000,
        });

        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}?iframe=true`,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
          },
        );

        await expectHtmlResponse(
          response,
          200,
          "data-checkout-popup",
          "Pay Now",
          'target="_blank"',
        );
      });
    });
  },
);
