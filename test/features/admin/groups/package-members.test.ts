/** The per-listing package prices and quantities the group edit form writes. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices } from "#shared/db/groups.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { adminPost } from "./helpers.ts";

describeWithEnv("admin package member overrides", { db: true }, () => {
  /** Save the group as a package with the given raw member inputs. */
  const savePackage = async (
    group: { id: number; name: string; slug: string },
    memberInputs: TestFormValues,
  ): Promise<void> => {
    const response = await adminPost(`/admin/groups/${group.id}/edit`, {
      description: "",
      is_package: "1",
      max_attendees: "0",
      name: group.name,
      slug: group.slug,
      terms_and_conditions: "",
      ...memberInputs,
    });
    expect(response.status).toBe(302);
  };

  test("stores the typed price and quantity for each member", async () => {
    const group = await createTestGroup({ name: "Priced package" });
    const member = await createTestListing({
      groupId: group.id,
      name: "Priced member",
      unitPrice: 900,
    });

    await savePackage(group, {
      [`package_price_${member.id}`]: "4.50",
      [`package_qty_${member.id}`]: "3",
    });
    expect(await getGroupPackagePrices(group.id)).toEqual([
      {
        group_id: group.id,
        listing_id: member.id,
        package_price: 450,
        quantity: 3,
      },
    ]);
  });

  test("falls back to no override and one unit for unusable inputs", async () => {
    const group = await createTestGroup({ name: "Sloppy package" });
    const member = await createTestListing({
      groupId: group.id,
      name: "Sloppy member",
      unitPrice: 900,
    });

    await savePackage(group, {
      [`package_price_${member.id}`]: "12abc",
      [`package_qty_${member.id}`]: "2abc",
    });
    expect(await getGroupPackagePrices(group.id)).toEqual([
      {
        group_id: group.id,
        listing_id: member.id,
        package_price: null,
        quantity: 1,
      },
    ]);
  });

  test("keeps an explicit free price and lifts a zero quantity to one", async () => {
    const group = await createTestGroup({ name: "Free package" });
    const member = await createTestListing({
      groupId: group.id,
      name: "Free member",
      unitPrice: 900,
    });

    await savePackage(group, {
      [`package_price_${member.id}`]: "0",
      [`package_qty_${member.id}`]: "0",
    });
    expect(await getGroupPackagePrices(group.id)).toEqual([
      {
        group_id: group.id,
        listing_id: member.id,
        package_price: 0,
        quantity: 1,
      },
    ]);
  });

  test("stores a per-day override for a customisable member", async () => {
    const group = await createTestGroup({ name: "Day package" });
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Day member",
      unitPrice: 500,
    });

    await savePackage(group, {
      [`package_day_price_${member.id}_2`]: "7.00",
      [`package_price_${member.id}`]: "",
      [`package_qty_${member.id}`]: "1",
    });
    expect(await getGroupDayPrices(group.id)).toEqual(
      new Map([[member.id, new Map([[2, 700]])]]),
    );
  });

  test("drops a day-price input that is not a number", async () => {
    const group = await createTestGroup({ name: "Bad day package" });
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Bad day member",
      unitPrice: 500,
    });

    await savePackage(group, {
      [`package_day_price_${member.id}_2`]: "nonsense",
      [`package_price_${member.id}`]: "",
      [`package_qty_${member.id}`]: "1",
    });
    expect(await getGroupDayPrices(group.id)).toEqual(new Map());
  });
});
