import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { formatCurrency } from "#shared/currency.ts";
import { invalidateAttendeeStatusesCache } from "#shared/db/attendee-statuses.ts";
import { getDb } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { modifiersTable, setModifierAnswers } from "#shared/db/modifiers.ts";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  extractCsrfToken,
  mockFormRequest,
  mockRequest,
  setupStripe,
} from "#test-utils";

/** GET the booking page for `pageSlug` to mint a CSRF token, then POST the
 * given inputs to `/calculate/<postSlug>` exactly as the running total would. */
const calculate = async (
  pageSlug: string,
  postSlug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const page = await handleRequest(mockRequest(`/ticket/${pageSlug}`));
  const csrf = extractCsrfToken(await page.text()) ?? "";
  return handleRequest(
    mockFormRequest(`/calculate/${postSlug}`, { csrf_token: csrf, ...data }),
  );
};

describeWithEnv("server (/calculate running total)", { db: true }, () => {
  test("returns a priced summary for a valid selection", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Adult Ticket",
      unitPrice: 1500,
    });

    const response = await calculate(listing.slug, listing.slug, {
      [`quantity_${listing.id}`]: "1",
    });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("Adult Ticket");
    expect(html).toContain(formatCurrency(1500));
    expect(html).toContain("order-summary-total");
    expect(html).toContain("Total");
  });

  test("quotes a package member at its override price, not its base price", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      name: "Day Pass",
      slug: "day-pass",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxQuantity: 5,
      name: "Pass Member",
      unitPrice: 5000,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 1500 },
    ]);

    const html = await (
      await calculate(group.slug, group.slug, {
        [`quantity_${member.id}`]: "1",
      })
    ).text();
    // The package override (1500) prices the line — not the 5000 base.
    expect(html).toContain(formatCurrency(1500));
    expect(html).not.toContain(formatCurrency(5000));
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
      await calculate(listing.slug, listing.slug, {
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
    const response = await calculate(listing.slug, listing.slug, {
      [`quantity_${listing.id}`]: "3",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Free Entry");
  });

  test("shows a prompt when nothing is selected", async () => {
    const listing = await createTestListing({ maxQuantity: 5, name: "Seat" });

    const response = await calculate(listing.slug, listing.slug, {
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

  test("prices a group booking posted to the group slug", async () => {
    await setupStripe();
    const group = await createTestGroup({ name: "Festival", slug: "festival" });
    const listing = await createTestListing({
      groupId: group.id,
      maxQuantity: 5,
      name: "Day Pass",
      unitPrice: 2000,
    });

    const response = await calculate("festival", "festival", {
      [`quantity_${listing.id}`]: "1",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Day Pass");
    expect(html).toContain(formatCurrency(2000));
  });

  test("shows the full value as owed when payments are disabled", async () => {
    // No payment provider configured: the submit path still completes the
    // booking but records the full value as the amount owed (like a zero-deposit
    // reservation), so the quote must surface that figure.
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Paid Seat",
      unitPrice: 2500,
    });

    const html = await (
      await calculate(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "2",
      })
    ).text();
    // Two seats at £25.00 = £50.00 owed, taken with no online payment.
    expect(html).toContain("you'll owe");
    expect(html).toContain(formatCurrency(5000));
  });

  test("shows no amount owed for a free booking when payments are disabled", async () => {
    // A genuinely free order owes nothing, so the quote keeps the free wording.
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Free Seat",
      unitPrice: 0,
    });

    const html = await (
      await calculate(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
      })
    ).text();
    expect(html).toContain("No payment required");
    expect(html).not.toContain("you'll owe");
  });

  test("rejects a sold-out answer tier in the quote", async () => {
    await setupStripe();
    const listing = await createTestListing({ maxAttendees: 50 });
    const question = await questionsTable.insert({
      displayType: "radio",
      text: "T-shirt size?",
    });
    const answer = await answersTable.insert({
      questionId: question.id,
      sortOrder: 0,
      text: "Small",
    });
    await setListingQuestions(listing.id, [question.id]);
    // A stock-limited answer tier with no stock left, selected by the quote.
    const tier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 5,
      direction: "charge",
      name: "VIP upgrade",
      stock: 0,
      trigger: "answer",
    });
    await setModifierAnswers(tier.id, [answer.id]);

    const html = await (
      await calculate(listing.slug, listing.slug, {
        [`question_${question.id}`]: String(answer.id),
        [`quantity_${listing.id}`]: "1",
      })
    ).text();
    expect(html).toContain("no longer available");
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
    const { attendeesApi } = await import("#shared/db/attendees.ts");
    const mockBatch = stub(attendeesApi, "checkBatchAvailability", () =>
      Promise.resolve(false),
    );
    try {
      const html = await (
        await calculate(listing.slug, listing.slug, {
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

  /** Set up a listing at £10.00 with a 10%-off promo code modifier ("SAVE10").
   * Returns the listing so tests can build their /calculate POST body. */
  const setupPromoListing = async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Workshop",
      unitPrice: 1000,
    });
    await modifiersTable.insert({
      calcKind: "percent",
      calcValue: 10,
      codeIndex: await hmacHash(normalizeCode("SAVE10")),
      direction: "discount",
      name: "10% off",
      trigger: "code",
    });
    return listing;
  };

  const quoteSave10Promo = async (): Promise<string> => {
    const listing = await setupPromoListing();
    return (
      await calculate(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
        promo_code: "SAVE10",
      })
    ).text();
  };

  test("applies a promo code discount when the correct code is submitted", async () => {
    const html = await quoteSave10Promo();

    // Discount line shown with modifier name and negative amount.
    expect(html).toContain("10% off");
    expect(html).toContain(formatCurrency(-100));
    // Total reflects the discounted price (10% off £10.00 = £9.00).
    expect(html).toContain(formatCurrency(900));
    expect(html).toContain("order-summary-total");
  });

  test("shows the listing price before modifiers, not the discounted line price", async () => {
    const html = await quoteSave10Promo();

    // The ticket line is the full £10.00 list price, so the discount isn't
    // baked into it — the modifier is itemised separately on its own row...
    expect(html).toContain(formatCurrency(1000));
    expect(html).toContain("10% off");
    expect(html).toContain(formatCurrency(-100));
    // ...and only the total carries the £9.00 discounted figure.
    expect(html).toContain(formatCurrency(900));
  });

  test("does not apply a promo code discount when no code is submitted", async () => {
    const listing = await setupPromoListing();

    const html = await (
      await calculate(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
      })
    ).text();

    // Full price — no promo code entered, no discount line.
    expect(html).toContain(formatCurrency(1000));
    expect(html).not.toContain(formatCurrency(900));
    expect(html).not.toContain("10% off");
  });

  test("does not apply a promo code discount when a wrong code is submitted", async () => {
    const listing = await setupPromoListing();

    const html = await (
      await calculate(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
        promo_code: "WRONGCODE",
      })
    ).text();

    // Full price — wrong promo code, no discount line.
    expect(html).toContain(formatCurrency(1000));
    expect(html).not.toContain(formatCurrency(900));
    expect(html).not.toContain("10% off");
  });

  /** Turn the seeded public-default status into a reservation charging `amount`,
   * so the quote prices each line as a deposit rather than the full price. */
  const setPublicReservation = async (amount: string): Promise<void> => {
    await getDb().execute({
      args: [amount],
      sql: "UPDATE attendee_statuses SET is_reservation = 1, reservation_amount = ? WHERE is_public_default = 1",
    });
    invalidateAttendeeStatusesCache();
  };

  test("shows the deposit charged now for a reservation, not the full list price", async () => {
    await setupStripe();
    await setPublicReservation("10%");
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Weekend Pass",
      unitPrice: 2000,
    });

    const html = await (
      await calculate(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
      })
    ).text();

    // A deposit summary shows what's due now (10% of £20.00 = £2.00), not the
    // full £20.00 list price — the deposit already reflects the reservation.
    expect(html).toContain("Weekend Pass");
    expect(html).toContain(formatCurrency(200));
    expect(html).not.toContain(formatCurrency(2000));
    expect(html).toContain("order-summary-total");
  });

  test("applies a promo code discount case-insensitively", async () => {
    const listing = await setupPromoListing();

    const html = await (
      await calculate(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
        promo_code: "save10",
      })
    ).text();

    // Lowercase variant of the code should still match.
    expect(html).toContain("10% off");
    expect(html).toContain(formatCurrency(-100));
    expect(html).toContain(formatCurrency(900));
  });
});
