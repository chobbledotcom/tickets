import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingInput } from "#shared/db/listings.ts";
import { validateListingInput } from "#shared/listings-actions.ts";
import { setupTestEncryptionKey, testListingInput } from "#test-utils";

setupTestEncryptionKey();

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
