import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingInput } from "#shared/db/listings.ts";
import {
  listingInputToEdge,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { setupTestEncryptionKey, testListingInput } from "#test-utils";

setupTestEncryptionKey();

describe("listingInputToEdge", () => {
  test("defaults every optional field for a sparse input", () => {
    const sparse = { name: "Bare" } as unknown as ListingInput;
    expect(listingInputToEdge(sparse, 7)).toEqual({
      customisable_days: false,
      day_prices: {},
      duration_days: 1,
      id: 7,
      listing_type: "standard",
      months_per_unit: 0,
      name: "Bare",
    });
  });

  test("carries through populated fields", () => {
    const input = {
      customisableDays: true,
      dayPrices: { 1: 100, 2: 200 },
      durationDays: 2,
      listingType: "daily",
      monthsPerUnit: 12,
      name: "Full",
    } as unknown as ListingInput;
    expect(listingInputToEdge(input, 3)).toEqual({
      customisable_days: true,
      day_prices: { 1: 100, 2: 200 },
      duration_days: 2,
      id: 3,
      listing_type: "daily",
      months_per_unit: 12,
      name: "Full",
    });
  });
});

describe("validateListingInput", () => {
  test("rejects assignBuiltSite with initialSiteMonths <= 0", async () => {
    const input: ListingInput = {
      ...testListingInput({
        assignBuiltSite: true,
        hidden: true,
        initialSiteMonths: 0,
        monthsPerUnit: 1,
        purchaseOnly: true,
      }),
      slug: "test-listing",
      slugIndex: "test-index",
    };
    const error = await validateListingInput(input);
    expect(error).toBe(
      "Initial site months is required when a site is assigned.",
    );
  });

  test("rejects assignBuiltSite without initial site months", async () => {
    const input: ListingInput = {
      ...testListingInput({
        assignBuiltSite: true,
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
      }),
      slug: "test-listing",
      slugIndex: "test-index",
    };
    const error = await validateListingInput(input);
    expect(error).toBe(
      "Initial site months is required when a site is assigned.",
    );
  });

  test("accepts assignBuiltSite when initial site months is positive", async () => {
    const input: ListingInput = {
      ...testListingInput({
        assignBuiltSite: true,
        hidden: true,
        initialSiteMonths: 1,
        monthsPerUnit: 1,
        purchaseOnly: true,
      }),
      slug: "test-listing",
      slugIndex: "test-index",
    };
    await expect(validateListingInput(input)).resolves.toBeNull();
  });

  test("rejects unsafe thank_you_url before webhook validation", async () => {
    const input: ListingInput = {
      ...testListingInput({
        thankYouUrl: "https://127.0.0.1/thanks",
        webhookUrl: "https://example.com/webhook",
      }),
      slug: "test-listing",
      slugIndex: "test-index",
    };
    await expect(validateListingInput(input)).resolves.toBe(
      "Thank you URL must be a public https:// domain",
    );
  });

  test("rejects unsafe webhook_url", async () => {
    const input: ListingInput = {
      ...testListingInput({
        thankYouUrl: "https://example.com/thanks",
        webhookUrl: "https://127.0.0.1/webhook",
      }),
      slug: "test-listing",
      slugIndex: "test-index",
    };
    await expect(validateListingInput(input)).resolves.toBe(
      "Webhook URL must be a public https:// domain",
    );
  });

  const customisableInput = (
    overrides: Partial<ListingInput>,
  ): ListingInput => ({
    ...testListingInput({ customisableDays: true, ...overrides }),
    slug: "test-listing",
    slugIndex: "test-index",
  });

  test("rejects customisable days combined with pay-more", async () => {
    const input = customisableInput({
      canPayMore: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
    });
    await expect(validateListingInput(input)).resolves.toBe(
      "Customisable days cannot be combined with Allow Pay More",
    );
  });

  test("rejects customisable days when neither prices nor a duration are set", async () => {
    const input = customisableInput({});
    await expect(validateListingInput(input)).resolves.toBe(
      "Set a price for at least one day count (1 up to the maximum days)",
    );
  });

  test("rejects customisable days with no priced day counts", async () => {
    const input = customisableInput({ dayPrices: {}, durationDays: 3 });
    await expect(validateListingInput(input)).resolves.toBe(
      "Set a price for at least one day count (1 up to the maximum days)",
    );
  });

  test("rejects customisable days when prices only exceed the maximum", async () => {
    const input = customisableInput({
      dayPrices: { 5: 4000 },
      durationDays: 3,
    });
    await expect(validateListingInput(input)).resolves.toBe(
      "Set a price for at least one day count (1 up to the maximum days)",
    );
  });

  test("accepts customisable days with at least one in-range price", async () => {
    const input = customisableInput({
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 3,
    });
    await expect(validateListingInput(input)).resolves.toBeNull();
  });
});
