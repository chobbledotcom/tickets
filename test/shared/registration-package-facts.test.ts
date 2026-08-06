import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { loadRegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const row = (packageGroupId: number) => ({
  attendee: { package_group_id: packageGroupId },
});

describeWithEnv("loadRegistrationPackageFacts", { db: true }, () => {
  test("does not read the database for rows outside a package", async () => {
    const calls = await countDatabaseCalls(0, async () => {
      expect(await loadRegistrationPackageFacts([row(0), row(-1)])).toEqual({
        displays: new Map(),
        pricingByGroup: new Map(),
      });
    });
    expect(calls).toBe(0);
  });

  test("loads each package once with its display and complete member pricing", async () => {
    const group = await createHiddenPackageGroup("Weekend bundle");
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 900, 2: 1600 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      name: "Cabin",
      unitPrice: 900,
    });
    await setGroupPackageMembers(group.id, [
      { dayPrices: { 2: 1400 }, listingId: member.id, price: 750, quantity: 3 },
    ]);
    const facts = await loadRegistrationPackageFacts([
      row(group.id),
      row(group.id),
      row(0),
    ]);
    expect(facts.displays).toEqual(
      new Map([[group.id, { hideListings: true, name: "Weekend bundle" }]]),
    );
    expect(facts.pricingByGroup).toEqual(
      new Map([
        [
          group.id,
          {
            dayPriceMap: new Map([[member.id, new Map([[2, 1400]])]]),
            memberIds: new Set([member.id]),
            priceMap: new Map([[member.id, 750]]),
            quantityMap: new Map([[member.id, 3]]),
          },
        ],
      ]),
    );
  });
});
