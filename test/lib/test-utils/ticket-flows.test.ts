import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getSessionCookieName } from "#shared/cookies.ts";
import {
  expectCheckoutRedirect,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import {
  getPageCsrfToken,
  submitJoinForm,
  submitMultiTicketForm,
  submitTicketForm,
} from "#test-utils/csrf.ts";
import {
  createTestDb,
  createTestDbWithSetup,
  resetDb,
} from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestInvite } from "#test-utils/db-helpers/misc.ts";
import { setTestSession } from "#test-utils/internal.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { loginAsAdmin } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";

describe("test-utils — ticket & join flows", () => {
  afterEach(() => {
    resetDb();
  });

  describe("submitTicketForm", () => {
    /** Assert a 302 and that the listing got exactly one attendee at `quantity`. */
    const expectSingleAttendeeQuantity = async (
      response: Response,
      listingId: number,
      quantity: number,
    ): Promise<void> => {
      expect(response.status).toBe(302);
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listingId);
      expect(attendees).toHaveLength(1);
      expect(attendees[0]!.quantity).toBe(quantity);
    };

    /** DB + Stripe set up, plus a pay-what-you-want listing. */
    const payableListing = async () => {
      await createTestDbWithSetup();
      await setupStripe();
      return createTestListing({
        canPayMore: true,
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 1000,
      });
    };

    test("submits a ticket form with CSRF token handling", async () => {
      await createTestDbWithSetup();
      const listing = await createTestListing();
      const response = await submitTicketForm(listing.slug, {
        email: "test@example.com",
        name: "Test User",
      });
      expect(response.status).toBe(302);
    });

    test("returns error response for non-existent slug", async () => {
      await createTestDbWithSetup();
      // Non-existent slug page has no form, falls back to signed token
      const response = await submitTicketForm("non-existent-slug", {
        email: "t@t.com",
        name: "Test",
      });
      expect(response.status).toBe(404);
    });

    test("maps generic quantity onto the single listing field", async () => {
      await createTestDbWithSetup();
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const response = await submitTicketForm(listing.slug, {
        email: "quantity@example.com",
        name: "Quantity User",
        quantity: "3",
      });
      await expectSingleAttendeeQuantity(response, listing.id, 3);
    });

    test("keeps an explicit single-listing quantity field over the generic field", async () => {
      await createTestDbWithSetup();
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const response = await submitTicketForm(listing.slug, {
        email: "explicit@example.com",
        name: "Explicit Quantity",
        quantity: "5",
        [`quantity_${listing.id}`]: "2",
      });
      await expectSingleAttendeeQuantity(response, listing.id, 2);
    });

    test("maps generic custom price onto the single listing field", async () => {
      const listing = await payableListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "25.00",
        email: "custom-price@example.com",
        name: "Custom Price",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });

    test("keeps an explicit custom price over the generic field", async () => {
      const listing = await payableListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "5.00",
        [`custom_price_${listing.id}`]: "25.00",
        email: "explicit-price@example.com",
        name: "Explicit Price",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });
  });

  describe("submitMultiTicketForm", () => {
    test("throws when the ticket page has no CSRF token", async () => {
      await createTestDbWithSetup();
      await expect(
        submitMultiTicketForm("missing-listing", {
          email: "missing@example.com",
          name: "Missing Listing",
        }),
      ).rejects.toThrow(
        "Failed to get CSRF token from /ticket/missing-listing",
      );
    });
  });

  describe("getPageCsrfToken", () => {
    beforeEach(async () => {
      await createTestDb();
    });

    test("returns CSRF token from setup page", async () => {
      const token = await getPageCsrfToken("/setup/");
      expect(token).toMatch(/^s1\./);
    });

    test("throws when page has no CSRF token", async () => {
      await expect(getPageCsrfToken("/health")).rejects.toThrow(
        "Failed to get CSRF token from /health",
      );
    });
  });

  describe("submitJoinForm", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("completes join flow and redirects to /join/complete", async () => {
      const { inviteCode } = await createTestInvite("joinhelper");
      const response = await submitJoinForm(inviteCode, {
        password: "newpassword123",
        password_confirm: "newpassword123",
      });
      expectRedirectWithFlash(
        "/join/complete",
        "Password set successfully",
      )(response);
    });

    test("returns error response for mismatched passwords", async () => {
      const { inviteCode } = await createTestInvite("joinhelper2");
      const response = await submitJoinForm(inviteCode, {
        password: "password123",
        password_confirm: "different",
      });
      expect(response.status).toBe(302);
    });
  });

  describe("createTestInvite", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an invite and returns the invite code", async () => {
      const { inviteCode, cookie, csrfToken } =
        await createTestInvite("invitee1");
      expect(inviteCode).toBeTruthy();
      expect(cookie).toContain(`${getSessionCookieName()}=`);
      expect(csrfToken).toMatch(/^s1\./);
    });

    test("throws when invite creation fails (duplicate username)", async () => {
      await createTestInvite("duplicate-user");
      await expect(createTestInvite("duplicate-user")).rejects.toThrow(
        "Failed to create invite",
      );
    });

    test("throws when invite creation fails without a redirect location", async () => {
      const { cookie } = await loginAsAdmin();
      setTestSession({ cookie, csrfToken: "not-a-signed-csrf-token" });

      await expect(createTestInvite("csrf-failure")).rejects.toThrow(
        "Failed to create invite for csrf-failure: 403 ",
      );
    });
  });

  describe("setupStripe", () => {
    test("configures Stripe as payment provider", async () => {
      await createTestDbWithSetup();
      await setupStripe();
      const { settings: s } = await import("#shared/db/settings.ts");
      expect(s.paymentProvider).toBe("stripe");
    });

    test("accepts a custom key", async () => {
      await createTestDbWithSetup();
      await setupStripe("sk_test_custom");
      const { settings: s } = await import("#shared/db/settings.ts");
      expect(s.paymentProvider).toBe("stripe");
    });
  });

  describe("mockWebhookRequest", () => {
    test("creates a POST request to /payment/webhook", () => {
      const req = mockWebhookRequest({ type: "test" });
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/payment/webhook");
      expect(req.headers.get("content-type")).toBe("application/json");
    });

    test("includes custom headers", () => {
      const req = mockWebhookRequest({}, { "stripe-signature": "sig_123" });
      expect(req.headers.get("stripe-signature")).toBe("sig_123");
      expect(req.headers.get("host")).toBe("localhost");
    });
  });

  describe("loginAsAdmin", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("returns cookie and CSRF token after successful login", async () => {
      const session = await loginAsAdmin();
      expect(session.cookie).toContain(`${getSessionCookieName()}=`);
      expect(session.csrfToken).toBeTruthy();
      expect(typeof session.csrfToken).toBe("string");
    });
  });
});
