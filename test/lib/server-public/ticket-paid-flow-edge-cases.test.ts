// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  bookAttendee,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectReservedRedirectWithTokens,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
  setupStripe,
  submitTicketForm,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket paid flow edge cases",
  { db: true, triggers: true },
  () => {
    describe("routes/public.ts (ticket paid flow)", () => {
      afterEach(() => {
        resetStripeClient();
      });

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

        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
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

        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

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
          const response = await handleRequest(
            mockFormRequest(
              path,
              {
                email: "john@example.com",
                name: "John Doe",
                [`quantity_${listing1.id}`]: "1",
                [`quantity_${listing2.id}`]: "1",
                csrf_token: csrfToken,
              },
              `csrf_token=${csrfToken}`,
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Failed to create payment session"),
            false,
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

        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const { stripePaymentProvider } = await import(
          "#shared/stripe-provider.ts"
        );
        const mockCreate = stub(
          stripePaymentProvider,
          "createCheckoutSession",
          () => Promise.resolve({ error: "Invalid phone number format" }),
        );

        try {
          const response = await handleRequest(
            mockFormRequest(
              path,
              {
                email: "john@example.com",
                name: "John Doe",
                [`quantity_${listing1.id}`]: "1",
                [`quantity_${listing2.id}`]: "1",
                csrf_token: csrfToken,
              },
              `csrf_token=${csrfToken}`,
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Invalid phone number format"),
            false,
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

        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        // Submit with qty for both listings, but listing1 should be skipped as sold out
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        // Should succeed for listing2 only
        expectReservedRedirectWithTokens(response);
      });
    });

    describe("routes/public.ts (ticket paid availability check fails)", () => {
      afterEach(() => {
        resetStripeClient();
      });

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

        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        // Mock checkBatchAvailability via attendeesApi to return false,
        // simulating a race condition where listing sells out between page load and check
        const { attendeesApi } = await import("#shared/db/attendees.ts");
        const mockBatch = stub(attendeesApi, "checkBatchAvailability", () =>
          Promise.resolve(false),
        );

        try {
          const response = await handleRequest(
            mockFormRequest(
              path,
              {
                email: "john@example.com",
                name: "John Doe",
                [`quantity_${listing1.id}`]: "1",
                [`quantity_${listing2.id}`]: "1",
                csrf_token: csrfToken,
              },
              `csrf_token=${csrfToken}`,
            ),
          );

          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("some tickets are no longer available"),
            false,
          );
        } finally {
          mockBatch.restore();
        }
      });
    });

    describe("iframe checkout popup (Stripe cannot run in iframes)", () => {
      afterEach(() => {
        resetStripeClient();
      });

      test("returns popup page instead of redirect for single-ticket paid listing in iframe", async () => {
        await setupStripe();
        const listing = await createTestListing({
          maxAttendees: 50,
          name: "Iframe Paid Single",
          unitPrice: 1000,
        });

        const path = `/ticket/${listing.slug}?iframe=true`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
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

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).not.toBeNull();
        expect(location?.startsWith("https://")).toBe(true);
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

        const path = `/ticket/${listing1.slug}+${listing2.slug}?iframe=true`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
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
