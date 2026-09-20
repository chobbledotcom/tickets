import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { requireCurrentRelationshipRules } from "#db/listing-relationship-validation.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  allAddOnWithStaleChildLink,
  groupAddOnWithStaleParentLink,
  parentAndChild,
} from "#test-utils/listing-parents/helpers.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";

describeWithEnv("db > listing relationship validation", { db: true }, () => {
  /** The rule check as the writers run it: a broken edge throws the edit
   *refusing, every edge holding resolves silently. */
  const check = (parentId: number, childId: number) =>
    withTransaction((tx) =>
      requireCurrentRelationshipRules(tx, [{ childId, parentId }]),
    );

  test("accepts an empty edge list", async () => {
    await withTransaction((tx) => requireCurrentRelationshipRules(tx, []));
  });

  test("accepts compatible current listing fields", async () => {
    const { parent, child } = await parentAndChild();
    await check(parent.id, child.id);
  });

  test("reports incompatible current listing fields with decrypted names", async () => {
    const parent = await createTestListing({ name: "Standard parent" });
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily child",
    });

    await expect(check(parent.id, child.id)).rejects.toThrow(
      t("listings_table.children_err_child_daily", { name: child.name }),
    );
  });

  test("uses every current day price when checking durations", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100, 2: 180 },
      durationDays: 2,
      listingType: "daily",
      name: "Flexible parent",
    });
    const child = await createTestListing({
      durationDays: 2,
      listingType: "daily",
      name: "Two-day child",
    });

    await check(parent.id, child.id);
  });

  test("reports a current child-only add-on", async () => {
    const { parent, child } = await parentAndChild();
    await optInAddOnForListings("Child extra", [child.id]);

    await expect(check(parent.id, child.id)).rejects.toThrow("Child extra");
  });

  test("refuses an edge whose parent assigns a built site", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    const parent = await createTestListing({
      assignBuiltSite: true,
      initialSiteMonths: 1,
      name: "Plan parent",
    });
    const child = await createTestListing({ name: "Plan child" });

    await expect(check(parent.id, child.id)).rejects.toThrow(
      t("listings_table.children_err_parent_site_plan", { name: parent.name }),
    );
  });

  test("refuses an edge whose child assigns a built site", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    const parent = await createTestListing({ name: "Plain parent" });
    const child = await createTestListing({
      assignBuiltSite: true,
      initialSiteMonths: 1,
      name: "Plan child",
    });

    await expect(check(parent.id, child.id)).rejects.toThrow(
      t("listings_table.children_err_child_site_plan", { name: child.name }),
    );
  });

  test("allows a standalone child to keep its own add-on", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({
      bookableAlone: true,
      name: "Standalone add-on",
    });
    await optInAddOnForListings("Standalone extra", [child.id]);

    await check(parent.id, child.id);
  });

  test("ignores stale listing links for a group-scoped add-on", async () => {
    const { parent, child } = await groupAddOnWithStaleParentLink();

    await expect(check(parent.id, child.id)).rejects.toThrow(
      "Group child extra",
    );
  });

  test("ignores stale listing links for an order-wide add-on", async () => {
    const { parent, child } = await allAddOnWithStaleChildLink();

    await check(parent.id, child.id);
  });

  test("checks every requested edge", async () => {
    const parent = await createTestListing({ name: "Shared parent" });
    const allowed = await createTestListing({ name: "Allowed child" });
    const blocked = await createTestListing({
      listingType: "daily",
      name: "Blocked child",
    });

    await expect(
      withTransaction((tx) =>
        requireCurrentRelationshipRules(tx, [
          { childId: allowed.id, parentId: parent.id },
          { childId: blocked.id, parentId: parent.id },
        ]),
      ),
    ).rejects.toThrow(
      t("listings_table.children_err_child_daily", { name: blocked.name }),
    );
  });
});
