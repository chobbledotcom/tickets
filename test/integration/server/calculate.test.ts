/** The `/calculate` running total: the plain quote mechanics — a priced
 * summary, booking-fee extras, PII stripping, the empty prompt, CSRF
 * rejection, sold-out answer tiers, capacity, and unknown slugs. Package,
 * promo-code, and deposit quotes live in focused files beside this one. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { modifiersTable } from "#db/modifiers.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { formatCurrency } from "#shared/currency.ts";
import { postRunningTotal, quoteTicketHtml } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { setupAnswerTier } from "#test-utils/modifiers.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("server (/calculate running total)", { db: true }, () => {
  test("returns a priced summary for a valid selection", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Adult Ticket",
      unitPrice: 1500,
    });

    const response = await postRunningTotal(listing.slug, listing.slug, {
      [`quantity_${listing.id}`]: "1",
    });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("Adult Ticket");
    expect(html).toContain(formatCurrency(1500));
    expect(html).toContain("order-summary-total");
    expect(html).toContain("Total");
  });

  test("prices a multi-unit line with a booking-fee extra line", async () => {
    await setupStripe();
    await settings.update.bookingFee("10");
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Workshop",
      unitPrice: 1000,
    });

    const html = await (
      await postRunningTotal(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "2",
      })
    ).text();

    // Two units priced as one line, labelled with the quantity.
    expect(html).toContain("2× Workshop");
    // Booking fee (10% of 2000) added as an extra line.
    expect(html).toContain("Booking fee");
    expect(html).toContain(formatCurrency(200));
    // Total = 2000 + 200 booking fee.
    expect(html).toContain(formatCurrency(2200));
  });

  test("totals without any contact details (PII is stripped)", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Free Entry",
      unitPrice: 0,
    });

    // No name/email/phone sent — a quote must not require them.
    const response = await postRunningTotal(listing.slug, listing.slug, {
      [`quantity_${listing.id}`]: "3",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Free Entry");
  });

  test("shows a prompt when nothing is selected", async () => {
    const listing = await createTestListing({ maxQuantity: 5, name: "Seat" });

    const response = await postRunningTotal(listing.slug, listing.slug, {
      [`quantity_${listing.id}`]: "0",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("order-summary-message");
    expect(html).toContain("Please select at least one ticket");
  });

  test("rejects an invalid CSRF token", async () => {
    const listing = await createTestListing({ maxQuantity: 5, name: "Seat" });

    const response = await handleRequest(
      mockFormRequest(`/calculate/${listing.slug}`, {
        csrf_token: "not-a-real-token",
        [`quantity_${listing.id}`]: "1",
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("order-summary-message");
  });

  test("rejects a sold-out answer tier in the quote", async () => {
    await setupStripe();
    const listing = await createTestListing({ maxAttendees: 50 });
    // A stock-limited answer tier with no stock left, selected by the quote.
    const { answerId, modifierId, questionId } = await setupAnswerTier(listing);

    const selection = {
      [`question_${questionId}`]: String(answerId),
      [`quantity_${listing.id}`]: "1",
    };
    expect(await quoteTicketHtml(listing.slug, selection)).toContain(
      "no longer available",
    );

    await modifiersTable.update(modifierId, { minVisits: 1 });
    expect(await quoteTicketHtml(listing.slug, selection)).not.toContain(
      "no longer available",
    );
  });

  test("reports unavailable tickets when capacity is exhausted", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Capped",
      unitPrice: 1000,
    });

    // Simulate capacity exhausted between page load and the quote (e.g. a dated
    // group day filling up), as the submit path's availability check would catch.
    const { attendeesApi } = await import("#db/attendees/api.ts");
    const mockBatch = stub(attendeesApi, "checkBatchAvailability", () =>
      Promise.resolve(false),
    );
    try {
      const html = await (
        await postRunningTotal(listing.slug, listing.slug, {
          [`quantity_${listing.id}`]: "1",
        })
      ).text();
      expect(html).toContain("no longer available");
      expect(html).not.toContain("order-summary-total");
    } finally {
      mockBatch.restore();
    }
  });

  test("returns 404 for an unknown single slug", async () => {
    const response = await handleRequest(
      mockFormRequest("/calculate/does-not-exist", {}),
    );
    expect(response.status).toBe(404);
  });

  test("returns 404 for unknown multi slugs without a group fallback", async () => {
    const response = await handleRequest(
      mockFormRequest("/calculate/missing-a+missing-b", {}),
    );
    expect(response.status).toBe(404);
  });
});
