import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#crypto/sealed.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { validateListingInput } from "#shared/listings-actions.ts";
import {
  inputFor,
  storedInputFor,
} from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("validateListingInput boundaries", { db: true }, () => {
  test("accepts a maximum price at least one currency unit above the ticket price", async () => {
    await expect(
      validateListingInput(
        inputFor({
          canPayMore: true,
          maxPrice: 1100,
          name: "Pay More OK",
          unitPrice: 1000,
        }),
      ),
    ).resolves.toBeNull();
  });

  test("states the exact minimum when a pay-more maximum is too low", async () => {
    await expect(
      validateListingInput(
        inputFor({
          canPayMore: true,
          maxPrice: 1099,
          name: "Pay More Low",
          unitPrice: 1000,
        }),
      ),
    ).resolves.toBe(
      `Maximum price must be at least ${formatCurrency(100)} more than the ticket price`,
    );
  });

  test("uses zero as the ticket price when an optional unit price is absent", async () => {
    const input = inputFor({
      canPayMore: true,
      maxPrice: 100,
      name: "No Base Price",
    });
    delete input.unitPrice;

    await expect(validateListingInput(input)).resolves.toBeNull();
  });

  test("keeps a minimum of one when no maximum is set", async () => {
    await expect(
      validateListingInput(
        inputFor({ maxAttendees: 10, minQuantity: 1, name: "Min One" }),
      ),
    ).resolves.toBeNull();
  });

  test("refuses a minimum above a maximum of zero", async () => {
    await expect(
      validateListingInput(
        inputFor({ maxQuantity: 0, minQuantity: 1, name: "Zero Max" }),
      ),
    ).resolves.toBe(t("error.listing_min_quantity_above_max"));
  });

  test("rejects a group id that does not exist", async () => {
    await expect(
      validateListingInput(
        inputFor({ groupIds: [999_999], name: "Missing Group" }),
      ),
    ).resolves.toBe(t("error.selected_group_deleted"));
  });

  test("checks every existing group member when creating a listing", async () => {
    const group = await createTestGroup({ name: "Daily Group" });
    await createTestListing({
      groupId: group.id,
      listingType: "daily",
      name: "Daily Member",
    });

    const error = await validateListingInput(
      inputFor({ groupIds: [group.id], name: "Standard Candidate" }),
    );
    expect(error).toContain("same type");
  });

  test("defaults an omitted customisable-days flag to false for group checks", async () => {
    const group = await createTestGroup({ name: "Standard Group" });
    await createTestListing({ groupId: group.id, name: "Standard Member" });
    const input = inputFor({
      groupIds: [group.id],
      name: "Default Standard Candidate",
    });
    delete input.customisableDays;

    await expect(validateListingInput(input)).resolves.toBeNull();
  });

  test("rejects an update that takes another listing's slug", async () => {
    const owner = await createTestListing({ name: "Slug Owner" });
    const editor = await createTestListing({ name: "Slug Editor" });
    const input = await storedInputFor(editor.id, {
      slug: owner.slug,
      slugIndex: "other-index" as BlindIndex,
    });

    await expect(validateListingInput(input, editor.id)).resolves.toBe(
      t("error.slug_in_use"),
    );
  });

  test("a create leaves slug collision handling to unique slug generation", async () => {
    const owner = await createTestListing({ name: "Create Slug Owner" });
    const input = inputFor({ name: "Create Slug Candidate" });

    await expect(
      validateListingInput({
        ...input,
        slug: owner.slug,
        slugIndex: "candidate-index" as BlindIndex,
      }),
    ).resolves.toBeNull();
  });
});

describeWithEnv("validateListingInput package edges", { db: true }, () => {
  test("allows a visible package member that gates its own children", async () => {
    const member = await createTestListing({ name: "Visible Member" });
    const child = await createTestListing({ name: "Visible Child" });
    await listingChildren.setIds(member.id, [child.id]);
    const group = await createTestGroup({
      isPackage: true,
      name: "Visible Package",
    });

    await expect(
      validateListingInput(
        inputFor({ groupIds: [group.id], name: member.name }),
        member.id,
      ),
    ).resolves.toBeNull();
  });

  test("rejects months per unit when No check-in is set without Hidden", async () => {
    await expect(
      validateListingInput(
        inputFor({
          hidden: false,
          monthsPerUnit: 1,
          name: "Renewal Mixed",
          purchaseOnly: true,
        }),
      ),
    ).resolves.toBe(
      "Months per unit requires No check-in and Hidden listing to be enabled.",
    );
  });
});

describeWithEnv("validateListingInput minimum quantity", { db: true }, () => {
  test("refuses a minimum below one with the exact catalog text", async () => {
    await expect(
      validateListingInput(
        inputFor({ maxQuantity: 10, minQuantity: 0, name: "Min Zero" }),
      ),
    ).resolves.toBe(t("error.listing_min_quantity_whole"));
  });

  test("refuses a fractional minimum from the number-typed API body", async () => {
    await expect(
      validateListingInput(
        inputFor({ maxQuantity: 10, minQuantity: 1.5, name: "Min Half" }),
      ),
    ).resolves.toBe(t("error.listing_min_quantity_whole"));
  });

  test("refuses a minimum above the maximum with the exact catalog text", async () => {
    await expect(
      validateListingInput(
        inputFor({ maxQuantity: 5, minQuantity: 6, name: "Min High" }),
      ),
    ).resolves.toBe(t("error.listing_min_quantity_above_max"));
  });

  test("accepts a minimum equal to the maximum", async () => {
    await expect(
      validateListingInput(
        inputFor({ maxQuantity: 8, minQuantity: 8, name: "Min Equal" }),
      ),
    ).resolves.toBeNull();
  });

  test("accepts an absent minimum on create", async () => {
    const input = inputFor({ maxQuantity: 5, name: "No Minimum" });
    delete input.minQuantity;

    await expect(validateListingInput(input)).resolves.toBeNull();
  });

  test("pairs an absent maximum with its stored default of one", async () => {
    // A create body that omits max_quantity stores 1, so a minimum above 1
    // pairs against that default and refuses.
    const input = inputFor({ minQuantity: 2, name: "Default Max" });
    delete input.maxQuantity;

    await expect(validateListingInput(input)).resolves.toBe(
      t("error.listing_min_quantity_above_max"),
    );
  });

  test("re-checks a merged update input against its maximum", async () => {
    // The admin JSON API merges the body over the stored row before calling
    // this rule, so the stored maximum arrives beside the body's minimum.
    const listing = await createTestListing({ maxQuantity: 3 });
    await expect(
      validateListingInput(
        await storedInputFor(listing.id, {
          // The factory's generated names collide on a second read; the rule
          // under test is the quantity pair, not name uniqueness.
          minQuantity: 4,
          name: "Merged Update Min High",
        }),
      ),
    ).resolves.toBe(t("error.listing_min_quantity_above_max"));
  });
});
