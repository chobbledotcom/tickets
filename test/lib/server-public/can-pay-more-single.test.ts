// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import { expectCheckoutRedirect, expectFlash } from "#test-utils/assertions.ts";
import { hasCheckedInput, submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockRequest } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { payMoreListing } from "./can-pay-more-listing.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > can_pay_more (single ticket)",
  { db: true, triggers: true },
  () => {
    describe("can_pay_more", () => {
      afterEach(() => {
        resetStripeClient();
      });

      /** GETs a listing's ticket page and returns the rendered HTML — the
       * shared fetch behind every can_pay_more price-input assertion below. */
      const getTicketHtml = async (
        listing: Awaited<ReturnType<typeof createTestListing>>,
      ): Promise<string> => {
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        return response.text();
      };

      /** Asserts a POST registered the buyer for free rather than sending
       * them to checkout — shared by the empty-price and zero-price
       * can_pay_more donation tests. */
      const expectFreeRegistrationNotCheckout = async (
        listing: Awaited<ReturnType<typeof createTestListing>>,
        response: Response,
      ): Promise<void> => {
        expect(response.status).toBe(302);
        const location = response.headers.get("location") || "";
        expect(location).not.toContain("checkout");
        const { getAttendeesRaw } = await import(
          "#shared/db/attendees/queries.ts"
        );
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      };

      test("GET shows price input when can_pay_more is enabled", async () => {
        const listing = await payMoreListing();
        const html = await getTicketHtml(listing);
        expect(html).toMatch(/name="custom_price(_\d+)?"/);

        expect(html).toContain("Price per ticket (£10 minimum)");
        expect(html).toContain('value="10.00"');
        expect(html).toContain("required");
      });

      test("GET does not show price input when can_pay_more is disabled", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          unitPrice: 1000,
        });
        const html = await getTicketHtml(listing);
        expect(html).not.toMatch(/name="custom_price(_\d+)?"/);
      });

      test("GET shows price input for can_pay_more listings with zero unit_price", async () => {
        const listing = await payMoreListing({ unitPrice: undefined });
        const html = await getTicketHtml(listing);
        expect(html).toMatch(/name="custom_price(_\d+)?"/);

        expect(html).toContain("Price per ticket (optional, up to £100)");
        expect(html).toContain('min="0.00"');
      });

      test("GET shows optional price input for free can_pay_more listings", async () => {
        const listing = await payMoreListing({ unitPrice: 0 });
        const html = await getTicketHtml(listing);
        expect(html).toMatch(/name="custom_price(_\d+)?"/);

        expect(html).toContain("Price per ticket (optional, up to £100)");
        expect(html).toContain('value="0.00" min="0.00" max="100.00"');
      });

      test("POST free can_pay_more with custom price redirects to checkout", async () => {
        await setupStripe();
        const listing = await payMoreListing({ unitPrice: 0 });
        const response = await submitTicketForm(listing.slug, {
          custom_price: "5.00",
          email: "donor@example.com",
          name: "Donor",
          quantity: "1",
        });
        expectCheckoutRedirect(response);
      });

      test("POST free can_pay_more with empty price registers for free", async () => {
        const listing = await payMoreListing({ unitPrice: 0 });
        const response = await submitTicketForm(listing.slug, {
          custom_price: "",
          email: "free@example.com",
          name: "Freebie",
          quantity: "1",
        });
        await expectFreeRegistrationNotCheckout(listing, response);
      });

      test("POST free can_pay_more with zero price registers for free", async () => {
        const listing = await payMoreListing({ unitPrice: 0 });
        const response = await submitTicketForm(listing.slug, {
          custom_price: "0",
          email: "free@example.com",
          name: "Freebie",
          quantity: "1",
        });
        await expectFreeRegistrationNotCheckout(listing, response);
      });

      test("POST rejects price below minimum", async () => {
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "5.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("minimum"), false);
      });

      test("POST accepts price at minimum and redirects to checkout", async () => {
        await setupStripe();
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "10.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expectCheckoutRedirect(response);
      });

      test("POST accepts price above minimum and redirects to checkout", async () => {
        await setupStripe();
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "25.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expectCheckoutRedirect(response);
      });

      test("POST rejects price above maximum", async () => {
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "150.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("maximum"), false);
      });

      test("POST preserves form values when price exceeds maximum", async () => {
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "150.00",
          email: "preserved@example.com",
          name: "Preserved Name",
          quantity: "1",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("maximum"), false);
      });

      test("POST accepts price at maximum", async () => {
        await setupStripe();
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "100.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expectCheckoutRedirect(response);
      });

      test("GET shows min price in label", async () => {
        const listing = await payMoreListing();
        const html = await getTicketHtml(listing);
        expect(html).toContain("£10 minimum");
      });

      test("GET shows max price for free can_pay_more listing", async () => {
        const listing = await payMoreListing({ unitPrice: 0 });
        const html = await getTicketHtml(listing);
        expect(html).toContain("up to £100");
      });

      test("POST rejects empty custom_price for paid can_pay_more listing", async () => {
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("enter a price"), false);
      });

      test("POST rejects invalid custom_price", async () => {
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "abc",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("valid price"), false);
      });

      test("POST rejects negative custom_price", async () => {
        const listing = await payMoreListing();
        const response = await submitTicketForm(listing.slug, {
          custom_price: "-5.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("valid price"), false);
      });

      test("admin edit page shows can_pay_more checked for enabled listing", async () => {
        const listing = await payMoreListing();
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/edit`,
          {
            cookie: await testCookie(),
          },
        );
        const html = await response.text();
        expect(hasCheckedInput(html, "can_pay_more", "1")).toBe(true);
      });

      test("admin edit page shows can_pay_more unchecked for disabled listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          unitPrice: 1000,
        });
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/edit`,
          {
            cookie: await testCookie(),
          },
        );
        const html = await response.text();
        expect(html).toContain('name="can_pay_more"');
        expect(hasCheckedInput(html, "can_pay_more", "1")).toBe(false);
      });

      test("POST respects custom max_price", async () => {
        const listing = await payMoreListing({ maxPrice: 2000 });
        const response = await submitTicketForm(listing.slug, {
          custom_price: "25.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("maximum"), false);
      });

      test("POST accepts price within custom max_price", async () => {
        await setupStripe();
        const listing = await payMoreListing({ maxPrice: 5000 });
        const response = await submitTicketForm(listing.slug, {
          custom_price: "45.00",
          email: "test@example.com",
          name: "Test User",
          quantity: "1",
        });
        expectCheckoutRedirect(response);
      });
    });
  },
);
