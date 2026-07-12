import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import type { ListingInput } from "#shared/db/listings/table.ts";
import {
  listingInputToEdge,
  performListingDelete,
  toggleListingActive,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { downloadRaw, uploadRaw } from "#shared/storage.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { withLocalStorageEnabled } from "#test-utils/mocks.ts";

setupTestEncryptionKey();

/** Build a full ListingInput from overrides for a validateListingInput call. */
const inputFor = (overrides: Partial<ListingInput>): ListingInput => ({
  ...testListingInput(overrides),
  slug: "some-slug",
  // Hand-crafted fixture stand-in for the blind index — test cast.
  slugIndex: "some-index" as BlindIndex,
  ...overrides,
});

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

// validateListingInput now reads the catalog (for cross-entity name
// uniqueness), so these cases run against an empty test DB — no listing/group
// shares these names, so the uniqueness check passes and each case exercises
// the specific rule it names.
describeWithEnv("validateListingInput", { db: true }, () => {
  /** A listing input with the slug fields every validation case needs; the
   * fixture index is a hand-crafted stand-in for the blind index (test cast). */
  const sluggedInput = (
    overrides: Partial<Parameters<typeof testListingInput>[0]> = {},
  ): ListingInput => ({
    ...testListingInput(overrides),
    slug: "test-listing",
    slugIndex: "test-index" as BlindIndex,
  });

  test("rejects assignBuiltSite with initialSiteMonths <= 0", async () => {
    const input: ListingInput = sluggedInput({
      assignBuiltSite: true,
      hidden: true,
      initialSiteMonths: 0,
      monthsPerUnit: 1,
      purchaseOnly: true,
    });
    const error = await validateListingInput(input);
    expect(error).toBe(
      "Initial site months is required when a site is assigned.",
    );
  });

  test("rejects assignBuiltSite without initial site months", async () => {
    const input: ListingInput = sluggedInput({
      assignBuiltSite: true,
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
    });
    const error = await validateListingInput(input);
    expect(error).toBe(
      "Initial site months is required when a site is assigned.",
    );
  });

  test("accepts assignBuiltSite when initial site months is positive", async () => {
    const input: ListingInput = sluggedInput({
      assignBuiltSite: true,
      hidden: true,
      initialSiteMonths: 1,
      monthsPerUnit: 1,
      purchaseOnly: true,
    });
    await expect(validateListingInput(input)).resolves.toBeNull();
  });

  test("rejects unsafe thank_you_url before webhook validation", async () => {
    const input: ListingInput = sluggedInput({
      thankYouUrl: "https://127.0.0.1/thanks",
      webhookUrl: "https://example.com/webhook",
    });
    await expect(validateListingInput(input)).resolves.toBe(
      "Thank you URL must be a public https:// domain",
    );
  });

  test("rejects unsafe webhook_url", async () => {
    const input: ListingInput = sluggedInput({
      thankYouUrl: "https://example.com/thanks",
      webhookUrl: "https://127.0.0.1/webhook",
    });
    await expect(validateListingInput(input)).resolves.toBe(
      "Webhook URL must be a public https:// domain",
    );
  });

  const customisableInput = (overrides: Partial<ListingInput>): ListingInput =>
    sluggedInput({ customisableDays: true, ...overrides });

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

  const NAME_IN_USE = "Name is already in use by another listing or group";

  const namedInput = (name: string): ListingInput => ({
    ...testListingInput({ name }),
    slug: "some-slug",
    // Hand-crafted fixture stand-in for the blind index — test cast.
    slugIndex: "some-index" as BlindIndex,
  });

  test("rejects a create whose name is used by an existing listing", async () => {
    await createTestListing({ name: "Taken Name" });
    await expect(validateListingInput(namedInput("Taken Name"))).resolves.toBe(
      NAME_IN_USE,
    );
  });

  test("rejects a create whose name is used by a group", async () => {
    await createTestGroup({ name: "Group Name" });
    await expect(validateListingInput(namedInput("Group Name"))).resolves.toBe(
      NAME_IN_USE,
    );
  });

  test("lets a listing keep its own name on edit", async () => {
    const listing = await createTestListing({ name: "Mine" });
    await expect(
      validateListingInput(namedInput("Mine"), listing.id),
    ).resolves.toBeNull();
  });

  test("rejects renaming a listing to another listing's name", async () => {
    const first = await createTestListing({ name: "First" });
    const second = await createTestListing({ name: "Second" });
    await expect(
      validateListingInput(namedInput(first.name), second.id),
    ).resolves.toBe(NAME_IN_USE);
  });
});

describeWithEnv("validateListingInput package membership", { db: true }, () => {
  test("rejects a package group when the listing is a child of another", async () => {
    const parent = await createTestListing({ name: "Edge Parent" });
    const child = await createTestListing({ name: "Edge Child" });
    await listingChildren.setIds(parent.id, [child.id]);
    const pkg = await createTestGroup({ isPackage: true, name: "Edge Pkg" });

    // A package member may never itself be another listing's child, and the
    // error names the offending listing and that specific reason.
    const error = await validateListingInput(
      inputFor({ groupIds: [pkg.id], name: "Edge Child" }),
      child.id,
    );
    expect(error).toBe(
      t("error.package_member_is_addon", { name: "Edge Child" }),
    );
  });

  test("rejects a hidden package when the listing gates its own children", async () => {
    const gp = await createTestListing({ name: "Gate Parent" });
    const gc = await createTestListing({ name: "Gate Child" });
    await listingChildren.setIds(gp.id, [gc.id]);
    const hidden = await createTestGroup({
      isPackage: true,
      name: "Hidden Pkg",
    });
    await groups.table.update(hidden.id, { hidePackageListings: true });

    // A hidden package collapses members to the package name, so a member that
    // gates children (would render a child selector) leaks them.
    const error = await validateListingInput(
      inputFor({ groupIds: [hidden.id], name: "Gate Parent" }),
      gp.id,
    );
    expect(error).toBe(
      t("error.package_member_gates_children_hidden", { name: "Gate Parent" }),
    );
  });
});

describeWithEnv("validateListingInput renewal config", { db: true }, () => {
  test("rejects months-per-unit without No Check-In and Hidden", async () => {
    const error = await validateListingInput(
      inputFor({ monthsPerUnit: 1, name: "Renewal One" }),
    );
    expect(error).toBe(
      "Months per unit requires No Check-In and Hidden to be enabled",
    );
  });

  test("accepts months-per-unit with No Check-In and Hidden", async () => {
    const error = await validateListingInput(
      inputFor({
        hidden: true,
        monthsPerUnit: 1,
        name: "Renewal Two",
        purchaseOnly: true,
      }),
    );
    expect(error).toBeNull();
  });
});

describeWithEnv("toggleListingActive", { db: true }, () => {
  test("is a no-op when already in the target state", async () => {
    const listing = await createTestListing({ name: "Toggle Noop" });
    const withCount = (await getListingWithCount(listing.id))!;
    expect(await toggleListingActive(listing.id, withCount, true)).toEqual({
      noChange: true,
    });
  });

  test("deactivates, persists, and logs the deactivation", async () => {
    const listing = await createTestListing({ name: "Toggle Off" });
    const withCount = (await getListingWithCount(listing.id))!;
    const result = await toggleListingActive(listing.id, withCount, false);
    expect("updated" in result && result.updated.active).toBe(false);
    const log = await getAllActivityLog();
    expect(
      log.some(
        (e) =>
          e.message.includes("Toggle Off") && e.message.includes("deactivated"),
      ),
    ).toBe(true);
  });

  test("reactivates and logs the reactivation", async () => {
    const listing = await createTestListing({ name: "Toggle On" });
    await listingsTable.update(listing.id, { active: false });
    const withCount = (await getListingWithCount(listing.id))!;
    const result = await toggleListingActive(listing.id, withCount, true);
    expect("updated" in result && result.updated.active).toBe(true);
    const log = await getAllActivityLog();
    expect(
      log.some(
        (e) =>
          e.message.includes("Toggle On") && e.message.includes("reactivated"),
      ),
    ).toBe(true);
  });
});

describeWithEnv("performListingDelete", { db: true }, () => {
  test("removes the row, deletes its storage files, and logs it", async () => {
    await withLocalStorageEnabled(async () => {
      const listing = await createTestListing({ name: "Delete Me" });
      await uploadRaw(new Uint8Array([1, 2, 3]), "delete-me.pdf");
      await listingsTable.update(listing.id, {
        attachmentName: "delete-me.pdf",
        attachmentUrl: "delete-me.pdf",
      });
      expect(await downloadRaw("delete-me.pdf")).not.toBeNull();

      const withCount = (await getListingWithCount(listing.id))!;
      await performListingDelete(withCount);

      expect(await getListingWithCount(listing.id)).toBeNull();
      expect(await downloadRaw("delete-me.pdf")).toBeNull();
      const log = await getAllActivityLog();
      expect(log.some((e) => e.message.includes("Delete Me"))).toBe(true);
    });
  });
});

describeWithEnv("validateListingInput edge rules", { db: true }, () => {
  test("accepts maxPrice at unit price + 1.00 for a pay-more listing", async () => {
    // minPrice is unitPrice + 100 (not × 100); 2000 clears 1000 + 100.
    const error = await validateListingInput(
      inputFor({
        canPayMore: true,
        maxPrice: 2000,
        name: "Pay More OK",
        unitPrice: 1000,
      }),
    );
    expect(error).toBeNull();
  });

  test("rejects maxPrice below unit price + 1.00 for a pay-more listing", async () => {
    const error = await validateListingInput(
      inputFor({
        canPayMore: true,
        maxPrice: 1050,
        name: "Pay More Low",
        unitPrice: 1000,
      }),
    );
    expect(error).toContain("Maximum price must be at least");
  });

  test("allows a visible package member that gates its own children", async () => {
    const member = await createTestListing({ name: "Vis Member" });
    const child = await createTestListing({ name: "Vis Child" });
    await listingChildren.setIds(member.id, [child.id]);
    const pkg = await createTestGroup({ isPackage: true, name: "Visible Pkg" });

    // A VISIBLE package renders a member's child selector like any parent row,
    // so a member that gates children is a valid member (unlike a hidden one).
    const error = await validateListingInput(
      inputFor({ groupIds: [pkg.id], name: "Vis Member" }),
      member.id,
    );
    expect(error).toBeNull();
  });

  test("rejects months-per-unit with No Check-In but not Hidden", async () => {
    const error = await validateListingInput(
      inputFor({
        hidden: false,
        monthsPerUnit: 1,
        name: "Renewal Mixed",
        purchaseOnly: true,
      }),
    );
    expect(error).toBe(
      "Months per unit requires No Check-In and Hidden to be enabled",
    );
  });

  test("a create ignores a slug already used by another listing", async () => {
    const owner = await createTestListing({ name: "Slug Owner" });
    // On create the slug is auto-uniquified downstream, so validation does not
    // reject a colliding slug (that check is update-only).
    const error = await validateListingInput({
      ...inputFor({ name: "Slug Taker" }),
      slug: owner.slug,
      // Hand-crafted fixture stand-in for the blind index — test cast.
      slugIndex: "taker-index" as BlindIndex,
    });
    expect(error).toBeNull();
  });
});
