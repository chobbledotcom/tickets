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
});
