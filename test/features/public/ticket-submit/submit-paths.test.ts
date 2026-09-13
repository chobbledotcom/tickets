/** Route-level tests of the ticket submit and quote paths in
 * `src/features/public/ticket-submit.ts`: the Square email rule, the
 * provider-less owed booking, the no-provider quote messages, the quote's
 * CSRF rejection, the site-menu gate, and the one-listing group page. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeeBalanceState } from "#db/attendees/balance.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { type ModifierInput, modifiersTable } from "#db/modifiers.ts";
import { settings } from "#db/settings.ts";
import { formatCurrency } from "#shared/currency.ts";
import { assertPublicHtml, expectFlash } from "#test-utils/assertions.ts";
import { quoteTicketHtml, submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  configureTestEmail,
  expectSingleTicketSvg,
} from "#test-utils/email.ts";
import { awaitTestRequest, useFetchStub } from "#test-utils/mocks.ts";
import { setupAnswerTier } from "#test-utils/modifiers.ts";
import { setPublicReservation } from "#test-utils/reservation/helpers.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/** Select Square as the payment provider without giving it credentials, so
 * the paid-field rules apply while bookings still take the provider-less
 * path (nothing can be charged through Square in tests). */
const selectProviderSquare = async (): Promise<void> => {
  await settings.update.paymentProvider("square");
};

/** Book under Square as a buyer whose phone number carries one previous
 * booking, with a visit-gated modifier live, and assert the paid-order email
 * rule rejects the form. The listing asks for a phone (so the repricing pass
 * can resolve the buyer's visit count) but never an email; only what the
 * modifier does to the repriced total differs between callers. */
const expectReturningBuyerRejectedForEmail = async (
  unitPrice: number,
  modifier: Pick<
    ModifierInput,
    "calcKind" | "calcValue" | "direction" | "name"
  >,
): Promise<void> => {
  await selectProviderSquare();
  const listing = await createTestListing({
    fields: "phone",
    maxAttendees: 50,
    unitPrice,
  });
  await modifiersTable.insert({ ...modifier, minVisits: 1 });
  await createTestAttendeeDirect(
    listing.id,
    "Returning Buyer",
    "returning@example.com",
    1,
    "07700 900000",
  );

  const response = await submitTicketForm(listing.slug, {
    name: "John Doe",
    phone: "07700 900000",
  });

  expectFlash(response, expect.stringContaining("Email is required"), false);
};

describeWithEnv("ticket submit paths", { db: true, triggers: true }, () => {
  describe("the Square email rule", () => {
    test("requires email for a paid booking even when the listing asks only for a name", async () => {
      await selectProviderSquare();
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const response = await submitTicketForm(listing.slug, {
        name: "John Doe",
      });

      expectFlash(
        response,
        expect.stringContaining("Email is required"),
        false,
      );
    });

    test("requires email for a one-penny paid booking", async () => {
      await selectProviderSquare();
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 50,
        unitPrice: 1,
      });

      const response = await submitTicketForm(listing.slug, {
        name: "John Doe",
      });

      expectFlash(
        response,
        expect.stringContaining("Email is required"),
        false,
      );
    });

    test("keeps requiring email for a one-penny order a discount would make free", async () => {
      // A returning buyer's 100% discount re-prices the £0.01 order to
      // nothing — but the order was paid when the form was first checked,
      // so the email Square demands of paid orders must still be there.
      await expectReturningBuyerRejectedForEmail(1, {
        calcKind: "percent",
        calcValue: 100,
        direction: "discount",
        name: "Loyalty",
      });
    });

    test("books a free booking without email", async () => {
      await selectProviderSquare();
      const listing = await createTestListing({
        fields: "",
        maxAttendees: 50,
      });

      const response = await submitTicketForm(listing.slug, {
        name: "John Doe",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("re-checks the email rule when repricing raises a one-penny total", async () => {
      // A one-penny surcharge for returning buyers: the first pass (no
      // contact, zero visits) prices the order free, the repriced order
      // with the buyer's real visit count costs exactly a penny — and a
      // paid order under Square must carry an email.
      await expectReturningBuyerRejectedForEmail(0, {
        calcKind: "fixed",
        calcValue: 0.01,
        direction: "charge",
        name: "Returning buyer fee",
      });
    });
  });
  describe("a provider-less paid booking with a deposit status", () => {
    const fetch = useFetchStub();

    test("charges nothing now, records the full value owed, and shows no paid price", async () => {
      await configureTestEmail();
      await setPublicReservation("50%");
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      // The ledger records the full value as owed and nothing collected —
      // the 50% deposit status cannot take a deposit with no provider
      // configured. The ticket attachment prices the booking by what the
      // buyer was charged, so it carries no paid price either.
      expect(response.status).toBe(302);
      const [attendee] = await getAttendeesRaw(listing.id);
      expect(
        (await getAttendeeBalanceState(attendee!.id))?.remainingBalance,
      ).toBe(1000);
      const svg = expectSingleTicketSvg(fetch.getFetchJsonBody());
      expect(svg).not.toContain("Price:");
      expect(svg).toContain("Qty: 1");
    });
  });

  describe("quotes without a payment provider", () => {
    test("tells the buyer they owe the full value of a paid order", async () => {
      const listing = await createTestListing({
        maxQuantity: 5,
        unitPrice: 1000,
      });

      const html = await quoteTicketHtml(listing.slug, {
        [`quantity_${listing.id}`]: "1",
      });

      expect(html).toContain(
        `No online payment is needed now — you'll owe ${formatCurrency(
          1000,
        )} for this booking.`,
      );
      expect(html).not.toContain("No payment required");
    });

    test("tells the buyer a free order needs no payment", async () => {
      const listing = await createTestListing({ maxQuantity: 5 });

      const html = await quoteTicketHtml(listing.slug, {
        [`quantity_${listing.id}`]: "1",
      });

      expect(html).toContain("No payment required for this booking.");
      expect(html).not.toContain("you'll owe");
    });

    test("tells the buyer they owe a one-penny order", async () => {
      const listing = await createTestListing({
        maxQuantity: 5,
        unitPrice: 1,
      });

      const html = await quoteTicketHtml(listing.slug, {
        [`quantity_${listing.id}`]: "1",
      });

      expect(html).toContain(
        `you'll owe ${formatCurrency(1)} for this booking.`,
      );
    });

    test("rejects a quote without a CSRF token as 403", async () => {
      const listing = await createTestListing({ maxQuantity: 5 });

      const response = await awaitTestRequest(`/calculate/${listing.slug}`, {
        data: { [`quantity_${listing.id}`]: "1" },
      });

      expect(response.status).toBe(403);
    });

    test("quotes cleanly for an answer tier a new buyer cannot reach", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      // Sold out, but gated behind a returning buyer's visit count — a
      // quote strips PII, so it runs at zero visits and cannot see the
      // tier. It must quote normally instead of reporting it sold out.
      const { answerId, questionId } = await setupAnswerTier(listing, {
        minVisits: 1,
      });

      const html = await quoteTicketHtml(listing.slug, {
        [`question_${questionId}`]: String(answerId),
        [`quantity_${listing.id}`]: "1",
      });

      expect(html).toContain("No payment required for this booking.");
      expect(html).not.toContain("no longer available");
    });
  });

  describe("the site menu on the booking page", () => {
    test("shows the menu when the public site is on", async () => {
      await enablePublicSite();
      const listing = await createTestListing({ maxAttendees: 50 });

      await assertPublicHtml(
        `/ticket/${listing.slug}`,
        'aria-label="Site menu"',
      );
    });

    test("hides the menu when the public site is off", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });

      const html = await assertPublicHtml(`/ticket/${listing.slug}`);
      expect(html).not.toContain('aria-label="Site menu"');
    });
  });

  test("renders a one-listing group page rather than 404", async () => {
    const group = await createTestGroup({ name: "Solo Group" });
    await createTestListing({
      groupId: group.id,
      maxAttendees: 50,
      name: "Only Member",
    });

    // A single member still renders the booking form — the all-children 404
    // must fire only when nothing standalone remains.
    await assertPublicHtml(
      `/ticket/${group.slug}`,
      "Solo Group",
      "Continue",
      `action="/ticket/${group.slug}"`,
    );
  });
});
