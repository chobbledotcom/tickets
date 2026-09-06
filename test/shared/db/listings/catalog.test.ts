import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import {
  getCatalogListings,
  getListingOfferFlags,
  getListingPickerNames,
} from "#db/listings/catalog.ts";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > listing catalog", { db: true }, () => {
  test("reads offer flags and picker names", async () => {
    const listing = await createTestListing({
      hidden: true,
      monthsPerUnit: 3,
      name: "Picker listing",
      purchaseOnly: true,
    });

    expect(await getListingOfferFlags(listing.id)).toEqual({
      active: true,
      hidden: true,
      months_per_unit: 3,
      purchase_only: true,
    });
    expect(await getListingOfferFlags(listing.id + 1)).toBeUndefined();
    expect(await getListingPickerNames()).toEqual(
      new Map([
        [
          listing.id,
          {
            active: true,
            hidden: true,
            months_per_unit: 3,
            name: "Picker listing",
            purchase_only: true,
          },
        ],
      ]),
    );
  });

  test("lists visible package members but omits hidden and inactive listings", async () => {
    const group = await createHiddenPackageGroup("Concealing package");
    const member = await createTestListing({
      groupId: group.id,
      name: "Independent member",
      unitPrice: 1234,
    });
    await createTestListing({ hidden: true, name: "Hidden listing" });
    const inactive = await createTestListing({ name: "Inactive listing" });
    await deactivateTestListing(inactive.id);

    expect(await getCatalogListings()).toEqual([
      {
        active: true,
        can_pay_more: false,
        customisable_days: false,
        hidden: false,
        id: member.id,
        listing_type: "standard",
        name: "Independent member",
        slug: member.slug,
        unit_price: 1234,
      },
    ]);
  });

  test("applies a hidden listing default to inherited listings", async () => {
    await settings.update.listingDefaults({ hidden: true });
    await createTestListing({
      hidden: false,
      name: "Inherits hidden",
      useDefaults: true,
    });

    expect(await getCatalogListings()).toEqual([]);
  });

  test("applies a visible listing default without exposing renewal tiers", async () => {
    await settings.update.listingDefaults({ hidden: false });
    const visible = await createTestListing({
      hidden: true,
      name: "Inherits visible",
      useDefaults: true,
    });
    await createTestListing({
      hidden: true,
      monthsPerUnit: 12,
      name: "Renewal tier",
      purchaseOnly: true,
      useDefaults: true,
    });

    expect((await getCatalogListings()).map((listing) => listing.id)).toEqual([
      visible.id,
    ]);
  });

  test("omits a required child unless it can be booked alone", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Required child" });
    await listingChildren.setIds(parent.id, [child.id]);

    expect((await getCatalogListings()).map((listing) => listing.id)).toEqual([
      parent.id,
    ]);
  });
});
