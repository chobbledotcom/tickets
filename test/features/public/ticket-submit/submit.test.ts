/**
 * The submit orchestration of `ticket-submit.ts`: which path a priced order
 * takes (paid checkout, free reservation, owed free booking), the Square
 * email rule during field validation, and the site-menu choice of the page a
 * submit comes from. These tests sit at the source's mirror path so the
 * mutation gate runs them against its submit logic.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeeOrderSummary } from "#db/attendees/balance.ts";
import { hashPhone } from "#db/contact-preferences.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { settings } from "#db/settings.ts";
import { stubWebhookFetch } from "#test/shared/webhook/helpers.ts";
import {
  assertPublicHtml,
  expectFlash,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { setContactVisits } from "#test-utils/contact-preferences.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { latestAttendee } from "#test-utils/reservation/helpers.ts";
import { enablePublicSite, setupStripe } from "#test-utils/settings.ts";

describeWithEnv("ticket submit", { db: true, triggers: true }, () => {
  describe("the page a submit comes from", () => {
    test("drops the site menu when the public site is off", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const html = await assertPublicHtml(`/ticket/${listing.slug}`, "<h1>");
      // With the public site off (the default), the menu's Home/Listings
      // links would only bounce a visitor to the admin login, so no menu.
      expect(html).not.toContain("admin-nav-group");
    });

    test("shows the site menu on a normal page when the public site is on", async () => {
      await enablePublicSite();
      const listing = await createTestListing({ maxAttendees: 50 });
      const html = await assertPublicHtml(`/ticket/${listing.slug}`, "<h1>");
      expect(html).toContain('<div class="admin-nav-group">');
      expect(html).toContain('aria-label="Site menu"');
    });

    test("still drops the menu in iframe mode when the public site is on", async () => {
      await enablePublicSite();
      const listing = await createTestListing({ maxAttendees: 50 });
      const html = await assertPublicHtml(
        `/ticket/${listing.slug}?iframe=true`,
        'class="iframe"',
      );
      expect(html).not.toContain("admin-nav-group");
    });
  });

  describe("completing a submitted booking", () => {
    test("keeps a zero-total order off the checkout while payments are enabled", async () => {
      await setupStripe("sk_test_fake_key");
      const listing = await createTestListing({
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0,
      });

      const response = await submitTicketForm(listing.slug, {
        email: "free@example.com",
        name: "Free Buyer",
      });

      expectRedirect(response, "https://example.com/thanks");
    });

    test("still charges a one-penny order through the checkout", async () => {
      await setupStripe();
      const listing = await createTestListing({
        thankYouUrl: "https://example.com",
        unitPrice: 1,
      });

      const response = await submitTicketForm(listing.slug, {
        email: "penny@example.com",
        name: "Penny Buyer",
      });

      expectRedirect(response, "checkout.stripe.com");
    });

    describe("with no payment provider configured", () => {
      const webhook = stubWebhookFetch();

      test("records a paid order as owed, never as collected", async () => {
        const listing = await createTestListing({
          thankYouUrl: "",
          unitPrice: 1000,
          webhookUrl: "https://example.com/hook",
        });

        const response = await submitTicketForm(listing.slug, {
          email: "owed@example.com",
          name: "Owed Buyer",
        });

        expectRedirect(response, "/ticket/reserved");
        const attendee = await latestAttendee();
        // The £10.00 sale leg stands with no payment leg posted: the whole
        // order stays owed to the site.
        expect(attendee.remainingBalance).toBe(1000);
        const summary = await getAttendeeOrderSummary(attendee.id);
        expect(summary.depositPaid).toBe(0);
        expect(summary.fullPrice).toBe(1000);
        // The registration webhook says the same: nothing was collected and
        // the full order is owed, because a provider-less booking charges
        // every line zero.
        const payload = webhook.firstBody();
        expect(payload.price_paid).toBe(0);
        expect(payload.amount_owed).toBe(1000);
      });
    });
  });

  describe("the Square email rule on paid bookings", () => {
    /** A booking page that collects a phone number instead of an email, so
     * the Square email rule is the only thing that can demand one. */
    const phoneOnlyListing = (unitPrice: number) =>
      createTestListing({
        fields: "phone",
        thankYouUrl: "https://example.com/thanks",
        unitPrice,
      });

    /** Square chosen without credentials: the field rules treat bookings as
     * paid, while payments stay disabled so nothing reaches a checkout. */
    const chooseSquare = () => settings.update.paymentProvider("square");

    /** A phone with one stored visit, so repricing sees a returning buyer. */
    const RETURNING_PHONE = "07700900001";
    const seedReturningBuyer = async (): Promise<void> => {
      await setContactVisits(await hashPhone(RETURNING_PHONE), 1);
    };

    /** A price change only a returning buyer's repricing sees: the initial
     * price ran at the buyer's unknown visit count (zero). `calcValue` is in
     * whole currency units, so a penny-sized change is 0.01. */
    const returningBuyerPriceChange = (
      direction: "charge" | "discount",
      calcValue: number,
    ) =>
      modifiersTable.insert({
        calcKind: "fixed",
        calcValue,
        direction,
        minVisits: 1,
        name:
          direction === "charge" ? "Regular visitor fee" : "Regular visitor",
      });

    /** Submit the page as the returning phone buyer and expect Square's
     * email demand — the demand a free booking never triggers. */
    const expectEmailDemanded = async (listing: { slug: string }) => {
      const response = await submitTicketForm(listing.slug, {
        name: "Phone Buyer",
        phone: RETURNING_PHONE,
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Your Email is required"),
        false,
      );
    };

    test("lets a phone-only free booking through", async () => {
      await chooseSquare();
      const listing = await phoneOnlyListing(0);

      const response = await submitTicketForm(listing.slug, {
        name: "Phone Buyer",
        phone: RETURNING_PHONE,
      });

      expectRedirect(response, "https://example.com/thanks");
    });

    test("still demands the email a one-penny order required from the start", async () => {
      await chooseSquare();
      await seedReturningBuyer();
      const listing = await phoneOnlyListing(1);
      await returningBuyerPriceChange("discount", 1);

      await expectEmailDemanded(listing);
    });

    test("demands the email a repriced order turns paid", async () => {
      await chooseSquare();
      await seedReturningBuyer();
      const listing = await phoneOnlyListing(0);
      // A penny onto a returning buyer's order, so the repriced order
      // becomes paid after the initial free price passed validation.
      await returningBuyerPriceChange("charge", 0.01);

      await expectEmailDemanded(listing);
    });
  });
});
