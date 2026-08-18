import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import {
  listingInputToEdge,
  performListingDelete,
  toggleListingActive,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { downloadRaw, uploadRaw } from "#shared/storage.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { withLocalStorageEnabled } from "#test-utils/mocks.ts";
import { inputFor } from "./listings-actions/helpers.ts";

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
      t("error.customisable_days_with_pay_more"),
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
  test("rejects months-per-unit without No check-in and Hidden", async () => {
    const error = await validateListingInput(
      inputFor({ monthsPerUnit: 1, name: "Renewal One" }),
    );
    expect(error).toBe(
      "Months per unit requires No check-in and Hidden listing to be enabled.",
    );
  });

  test("accepts months-per-unit with No check-in and Hidden", async () => {
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
    expect(result).toMatchObject({ updated: { active: false } });
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
    expect(result).toMatchObject({ updated: { active: true } });
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

  test("keeps the attachment file when the database delete fails", async () => {
    await withLocalStorageEnabled(async () => {
      const listing = await createTestListing({ name: "Delete Blocked" });
      await uploadRaw(new Uint8Array([4, 5, 6]), "delete-blocked.pdf");
      await listingsTable.update(listing.id, {
        attachmentName: "delete-blocked.pdf",
        attachmentUrl: "delete-blocked.pdf",
      });
      const withCount = (await getListingWithCount(listing.id))!;

      await withDbFault(
        `CREATE TRIGGER test_listing_delete_fault
          BEFORE DELETE ON listings
          BEGIN
            SELECT RAISE(ABORT, 'listing delete unavailable');
          END`,
        "test_listing_delete_fault",
        async () => {
          await expect(performListingDelete(withCount)).rejects.toThrow(
            "listing delete unavailable",
          );
        },
      );

      expect(await getListingWithCount(listing.id)).not.toBeNull();
      expect(await downloadRaw("delete-blocked.pdf")).not.toBeNull();
    });
  });
});
