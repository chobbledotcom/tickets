// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { hashPhone } from "#shared/db/contact-preferences.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { settings } from "#shared/db/settings.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  expectAttendeeCounts,
  expectCheckoutRedirect,
  expectFlash,
  expectRedirect,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import { setContactVisits } from "#test-utils/contact-preferences.ts";
import {
  getTicketCsrfToken,
  submitMultiTicketForm,
  submitTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** A free, phone-only listing plus a £5 "Returning customer fee" modifier
 * that only fires once the buyer's phone has visited before — the shared
 * setup behind both returning-customer Square tests below (one records the
 * visit without an email configured, the other with). */
const setupReturningCustomerFeeListing = async () => {
  await setContactVisits(await hashPhone("555-1234"), 1);
  const listing = await createTestListing({
    fields: "phone",
    maxAttendees: 50,
    thankYouUrl: "https://example.com/thanks",
    unitPrice: 0,
  });
  await modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    minVisits: 1,
    name: "Returning customer fee",
    trigger: "automatic",
  });
  return listing;
};

describeWithEnv(
  "server public > ticket additional coverage",
  { db: true, triggers: true },
  () => {
    describe("routes/public.ts (additional coverage)", () => {
      test("ticket form with phone-only fields (no email field) works", async () => {
        const listing = await createTestListing({
          fields: "phone",
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks",
        });

        const response = await submitTicketForm(listing.slug, {
          name: "John Doe",
          phone: "555-1234",
        });
        // With fields="phone", email is not collected and extractContact returns "" for email
        expectRedirect(response, "https://example.com/thanks");
      });

      test("Square requires email when a free listing has a paid add-on", async () => {
        await settings.update.paymentProvider("square");
        const listing = await createTestListing({
          fields: "phone",
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks",
          unitPrice: 0,
        });
        const addOn = await modifiersTable.insert({
          calcKind: "fixed",
          calcValue: 5,
          direction: "charge",
          name: "Workshop kit",
          trigger: "optional",
        });

        const page = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const html = await page.text();
        expect(html).toContain('name="email"');

        const response = await submitTicketForm(listing.slug, {
          [`addon_${addOn.id}`]: "1",
          name: "John Doe",
          phone: "555-1234",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Your Email is required"),
          false,
        );
      });

      test("Square requires email when a returning-customer charge makes a free listing paid", async () => {
        await settings.update.paymentProvider("square");
        const listing = await setupReturningCustomerFeeListing();

        const response = await submitTicketForm(listing.slug, {
          name: "John Doe",
          phone: "555-1234",
        });

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Your Email is required"),
          false,
        );
      });

      test("Square redirects when a returning-customer charge has the required email", async () => {
        await settings.update.paymentProvider("square");
        await settings.update.square.accessToken("EAAAl_test_123");
        await settings.update.square.locationId("L_test_123");
        const listing = await setupReturningCustomerFeeListing();
        const { squarePaymentProvider } = await import(
          "#shared/square-provider.ts"
        );
        let capturedIntent:
          | import("#shared/payments.ts").CheckoutIntent
          | undefined;
        const checkout = stub(
          squarePaymentProvider,
          "createCheckoutSession",
          (intent: import("#shared/payments.ts").CheckoutIntent) => {
            capturedIntent = intent;
            return Promise.resolve({
              checkoutUrl: "https://square.example/checkout",
              sessionId: "square_order_123",
            });
          },
        );

        try {
          const response = await submitTicketForm(listing.slug, {
            email: "john@example.com",
            name: "John Doe",
            phone: "555-1234",
          });

          expectCheckoutRedirect(response);
          expect(capturedIntent?.email).toBe("john@example.com");
        } finally {
          checkout.restore();
        }
      });

      test("ticket form with invalid quantity rejects submission", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          thankYouUrl: "https://example.com/thanks",
        });

        // Submit with non-numeric quantity — parsed as 0, rejected
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing.id}`]: "abc",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("select at least one ticket"),
          false,
        );
      });

      test("skips sold-out listings in quantity parsing", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 1,
          maxQuantity: 1,
          name: "Multi Soldout Parse 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Soldout Parse 2",
        });

        // Fill up listing1 to make it sold out
        await bookAttendee(listing1, {
          email: "first@example.com",
          name: "First",
          quantity: 1,
        });

        // GET the ticket page (sold-out listing will show Sold Out label)
        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        expect(getResponse.status).toBe(200);
        const html = await getResponse.text();
        expect(html).toContain("Sold Out");

        // POST with quantity for both listings - sold out listing's quantity is ignored
        const csrfToken = getTicketCsrfToken(html);
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
        expectReservedRedirectWithTokens(response);
      });

      test("ticket with invalid quantity form value falls back to 0", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Invalid Qty 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Invalid Qty 2",
        });

        // Submit with non-numeric quantity for listing1 and valid for listing2
        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "abc",
            [`quantity_${listing2.id}`]: "1",
          },
        );
        expectReservedRedirectWithTokens(response);

        // Only listing2 should have an attendee
        await expectAttendeeCounts([
          { count: 0, listingId: listing1.id },
          { count: 1, listingId: listing2.id },
        ]);
      });

      test("ticket paid checks availability and rejects sold out", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 1,
          maxQuantity: 5,
          name: "Multi Avail 1",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Avail 2",
          unitPrice: 1000,
        });

        // Fill listing1
        await bookAttendee(listing1, {
          email: "first@example.com",
          name: "First",
          paymentId: "pi_first",
        });

        // Try to purchase - listing1 is sold out
        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing2.id}`]: "1",
          },
        );

        // Should redirect to checkout since only listing2 has quantity (listing1 is sold out and skipped)
        expect(response.status).toBe(302);
        resetStripeClient();
      });

      test("returns null for non-ticket paths", async () => {
        const response = await handleRequest(mockRequest("/notticket/test"));
        expect(response.status).toBe(404);
      });

      test("returns null when slug is empty from path extraction", async () => {
        const response = await handleRequest(mockRequest("/ticket/"));
        // Path /ticket/ is normalized to /ticket, which doesn't match slug pattern
        expect(response.status).toBe(404);
      });
    });
  },
);
