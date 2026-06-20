import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { formatCurrency } from "#shared/currency.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  extractCsrfToken,
  mockFormRequest,
  mockRequest,
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

  test("prices a multi-unit line with a booking-fee extra line", async () => {
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
