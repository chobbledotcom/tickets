// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

// Enables Stripe and creates a standard paid listing: 50 spots that redirect
// to the thank-you page on success, priced at the given amount.
const setupPaidListing = async (unitPrice: number, stripeKey?: string) => {
  await setupStripe(stripeKey);
  return await createTestListing({
    maxAttendees: 50,
    thankYouUrl: "https://example.com/thanks",
    unitPrice,
  });
};

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("payment routes", () => {
    test("returns 404 for unsupported method on payment routes", async () => {
      const response = await awaitTestRequest("/payment/success", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("ticket purchase with payments enabled", () => {
    // These tests use the stripe-mock host and port chosen by the harness.
    // Stripe keys are now set via environment variables

    afterEach(() => {
      resetStripeClient();
    });

    test("handles payment flow error when Stripe fails", async () => {
      // Set a fake Stripe key to enable payments, and make a paid listing
      const listing = await setupPaidListing(1000, "sk_test_fake_key");

      // Try to reserve a ticket - should fail because Stripe key is invalid
      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect with error because Stripe session creation fails
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Failed to create payment session"),
        false,
      );
    });

    test("shows specific error when payment provider returns validation error", async () => {
      const listing = await setupPaidListing(1000);

      // Mock createCheckoutSession to return a validation error result
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () =>
          Promise.resolve({
            error:
              "The payment processor rejected the phone number as invalid. Please correct it and try again.",
          }),
      );

      try {
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
        });

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining(
            "payment processor rejected the phone number",
          ),
          false,
        );
      } finally {
        mockCreate.restore();
      }
    });

    test("free ticket still works when payments enabled", async () => {
      // Create a free listing (no price)
      const listing = await setupPaidListing(0, "sk_test_fake_key");

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to thank you page
      expectRedirect(response, "https://example.com/thanks");
    });

    test("free customisable-days booking reserves the chosen number of days", async () => {
      await setupStripe("sk_test_fake_key");

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0 },
        durationDays: 2,
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });

      const response = await submitTicketForm(listing.slug, {
        day_count: "2",
        email: "john@example.com",
        name: "John Doe",
      });

      expectRedirect(response, "https://example.com/thanks");
    });

    test("rejects a booking with no day count chosen for a customisable listing", async () => {
      await setupStripe("sk_test_fake_key");

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0 },
        durationDays: 2,
        maxAttendees: 50,
      });

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("choose how many days"),
        false,
      );
    });

    test("creates a checkout session for a customisable-days listing priced by day count", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });

      const { checkout, getCaptured } = stubCheckout("cs_customisable_web");

      try {
        const response = await submitTicketForm(listing.slug, {
          day_count: "2",
          email: "john@example.com",
          name: "John Doe",
        });

        expect(response.status).toBe(302);
        // The chosen span and its price are carried into the checkout intent.
        expect(getCaptured()?.dayCount).toBe(2);
        expect(getCaptured()?.items[0]?.unitPrice).toBe(1800);
      } finally {
        checkout.restore();
      }
    });

    test("carries a selected add-on and entered promo code into the checkout intent", async () => {
      const listing = await setupPaidListing(1000);

      // An opt-in add-on and a promo-code discount, both whole-order. A second
      // add-on is offered but left unselected (its quantity field stays 0).
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "T-shirt",
      });
      const skippedAddOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 3,
        direction: "charge",
        name: "Tote bag",
      });
      const promo = await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "SAVE10",
      });
      await getDb().execute({
        args: ["optional", addOn.id],
        sql: "UPDATE modifiers SET trigger = ? WHERE id = ?",
      });
      await getDb().execute({
        args: ["optional", skippedAddOn.id],
        sql: "UPDATE modifiers SET trigger = ? WHERE id = ?",
      });
      await getDb().execute({
        args: ["code", await hmacHash(normalizeCode("SAVE10")), promo.id],
        sql: "UPDATE modifiers SET trigger = ?, code_index = ? WHERE id = ?",
      });

      const { checkout, getCaptured } = stubCheckout("cs_modifiers_web");

      try {
        const response = await submitTicketForm(listing.slug, {
          // The second add-on's field is omitted entirely (left unselected).
          [`addon_${addOn.id}`]: "2",
          email: "john@example.com",
          name: "John Doe",
          promo_code: "save10",
        });

        expect(response.status).toBe(302);
        const byId = new Map(
          (getCaptured()?.modifiers ?? []).map((m) => [m.id, m]),
        );
        // The add-on is applied at the chosen quantity, the promo at quantity 1,
        // and the unselected add-on is absent.
        expect(byId.get(addOn.id)?.quantity).toBe(2);
        expect(byId.get(promo.id)?.quantity).toBe(1);
        expect(byId.has(skippedAddOn.id)).toBe(false);
      } finally {
        checkout.restore();
      }
    });

    test("zero price ticket is treated as free", async () => {
      // Create listing with 0 price
      const listing = await setupPaidListing(0, "sk_test_fake_key");

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to thank you page (no payment required)
      expectRedirect(response, "https://example.com/thanks");
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      const listing = await setupPaidListing(1000);

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // Should redirect to Stripe checkout URL
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      // stripe-mock returns a URL starting with https://
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("rejects paid listing registration when sold out before payment", async () => {
      await setupStripe();

      // Create paid listing with only 1 spot
      const listing = await createTestListing({
        maxAttendees: 1,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Fill the listing (using atomic to simulate production flow)
      await bookAttendee(listing, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      // Try to register - should fail before Stripe session is created
      const response = await submitTicketForm(listing.slug, {
        email: "second@example.com",
        name: "Second",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("not enough spots available"),
        false,
      );
    });
  });
});
