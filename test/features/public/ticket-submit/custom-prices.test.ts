/**
 * Direct tests for the custom prices at form parse: a pay-more listing reads
 * its posted price, and fixed-price or unchosen listings stay out of the map.
 */

/* jscpd:ignore-start -- imports */
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { customPriceFieldName } from "#booking/tree.ts";
import { parseCustomPrices } from "#routes/public/ticket-submit/parse.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { priceFormValue } from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { quantityForm, ticketContext } from "#test-utils/ticket-ctx.ts";

/* jscpd:ignore-end */

/** A pay-more listing's custom-price outcome: the listing is created with the
 * given overrides, its field carries `priceMinor`, and the parser answers. */
const customPriceOutcome = async (
  overrides: Record<string, unknown>,
  priceMinor: number,
) => {
  const listing = await createTestListing({
    canPayMore: true,
    unitPrice: 1000,
    ...overrides,
  });
  const ctx = await ticketContext([listing.id]);
  const form = quantityForm({ [listing.id]: 1 });
  form.set(customPriceFieldName(listing.id), priceFormValue(priceMinor));
  return {
    listing,
    result: parseCustomPrices(form, ctx, new Map([[listing.id, 1]])),
  };
};

describeWithEnv("ticket-submit parse", { db: true }, () => {
  describe("parseCustomPrices", () => {
    test("reads a pay-more listing's custom price into the map", async () => {
      const { listing, result } = await customPriceOutcome(
        { maxPrice: 5000 },
        1500,
      );
      expect(result).toEqual(new Map([[listing.id, 1500]]));
    });

    test("refuses a price below the listing's own price, naming it", async () => {
      const { result } = await customPriceOutcome(
        { name: "Supporter ticket" },
        500,
      );
      expect(typeof result).toBe("string");
      // A Map result fails the assertion.
      const priceMessage = typeof result === "string" ? result : "";
      assertStringIncludes(priceMessage, "Supporter ticket");
    });

    test("ignores a pay-more listing the buyer chose none of", async () => {
      const listing = await createTestListing({ canPayMore: true });
      const ctx = await ticketContext([listing.id]);

      const result = parseCustomPrices(
        quantityForm({ [listing.id]: 0 }),
        ctx,
        new Map(),
      );
      expect(result).toEqual(new Map());
    });

    test("ignores a fixed-price listing even when its field is posted", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set(customPriceFieldName(listing.id), "1");

      const result = parseCustomPrices(form, ctx, new Map([[listing.id, 1]]));
      expect(result).toEqual(new Map());
    });
  });
});
