/** The per-listing package prices and quantities the group edit form writes. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices } from "#shared/db/groups.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import type { GroupListing, ListingWithCount } from "#shared/types.ts";
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

  /** Save a one-member package with the typed price and quantity, and hand
   * back the member row it stored. */
  const savedMemberRow = async (
    label: string,
    typed: { price: string; quantity: string },
  ): Promise<GroupListing> => {
    const group = await createTestGroup({ name: `${label} package` });
    const member = await createTestListing({
      groupId: group.id,
      name: `${label} member`,
      unitPrice: 900,
    });
    await savePackage(group, {
      [`package_price_${member.id}`]: typed.price,
      [`package_qty_${member.id}`]: typed.quantity,
    });
    const rows = await getGroupPackagePrices(group.id);
    const row = rows[0];
    if (!row) throw new Error(`${label} member has no membership row`);
    expect(rows).toHaveLength(1);
    expect(row.listing_id).toBe(member.id);
    return row;
  };

  /** A one-member package whose member can be priced per day. */
  const dayPricedPackage = async (
    label: string,
  ): Promise<{
    group: { id: number; name: string; slug: string };
    member: ListingWithCount;
  }> => {
    const group = await createTestGroup({ name: `${label} package` });
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: `${label} member`,
      unitPrice: 500,
    });
    return { group, member };
  };

  test("stores the typed price and quantity for each member", async () => {
    const row = await savedMemberRow("Priced", {
      price: "4.50",
      quantity: "3",
    });
    expect(row.package_price).toBe(450);
    expect(row.quantity).toBe(3);
  });

  test("falls back to no override and one unit for unusable inputs", async () => {
    const row = await savedMemberRow("Sloppy", {
      price: "12abc",
      quantity: "2abc",
    });
    expect(row.package_price).toBeNull();
    expect(row.quantity).toBe(1);
  });

  test("keeps an explicit free price and lifts a zero quantity to one", async () => {
    const row = await savedMemberRow("Free", { price: "0", quantity: "0" });
    expect(row.package_price).toBe(0);
    expect(row.quantity).toBe(1);
  });

  test("stores a per-day override for a customisable member", async () => {
    const { group, member } = await dayPricedPackage("Day");

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
    const { group, member } = await dayPricedPackage("Bad day");

    await savePackage(group, {
      [`package_day_price_${member.id}_2`]: "nonsense",
      [`package_price_${member.id}`]: "",
      [`package_qty_${member.id}`]: "1",
    });
    expect(await getGroupDayPrices(group.id)).toEqual(new Map());
  });
});
