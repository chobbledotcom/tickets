/** Direct unit tests for the listing join preparation and persistence
 *  extracted from api.ts. The API integration tests in api/regressions.test.ts
 *  exercise the full request path; these test the extracted functions
 *  directly so mutation testing has a mirror for api-listing-joins.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  persistListingJoins,
  prepareListingJoins,
} from "#routes/admin/api-listing-joins.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { withTransaction } from "#shared/db/client.ts";
import { listingGroups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingDayPrices } from "#shared/db/listing-prices.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingInput } from "#test-utils/factories.ts";

const baseInput = (
  overrides: Parameters<typeof testListingInput>[0] = {},
): ReturnType<typeof testListingInput> & {
  slug: string;
  slugIndex: BlindIndex;
} => {
  const { groupIds, ...rest } = overrides;
  return {
    ...testListingInput({ name: "Test listing", ...rest }),
    ...(groupIds !== undefined ? { groupIds } : {}),
    slug: "test-listing",
    slugIndex: "test-listing-index" as BlindIndex,
  };
};

describeWithEnv("api-listing-joins", { db: true }, () => {
  test("returns null child edges when child_listing_ids is omitted", async () => {
    const result = await prepareListingJoins(baseInput(), {}, null);

    expect(result).toEqual({
      value: { childEdges: null, dayPrices: undefined, groupIds: undefined },
    });
  });

  test("rejects a non-array child_listing_ids", async () => {
    const result = await prepareListingJoins(
      baseInput(),
      { child_listing_ids: "1" },
      null,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe(
        "child_listing_ids must be an array of listing ids",
      );
    }
  });

  test("rejects a fractional child_listing_ids entry", async () => {
    const result = await prepareListingJoins(
      baseInput(),
      { child_listing_ids: [1.5] },
      null,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe(
        "child_listing_ids must contain only positive integer listing ids",
      );
    }
  });

  test("accepts positive integer child_listing_ids and returns them cleaned", async () => {
    const child = await createTestListing({ name: "Valid child" });

    const result = await prepareListingJoins(
      baseInput(),
      { child_listing_ids: [child.id] },
      null,
    );

    expect("value" in result).toBe(true);
    if ("value" in result) {
      expect(result.value.childEdges).toEqual([child.id]);
    }
  });

  test("rejects child edges when the listing is in a hidden package", async () => {
    const hiddenPackage = await createHiddenPackageGroup("Edge hidden pkg");
    const child = await createTestListing({ name: "Hidden pkg child" });

    const result = await prepareListingJoins(
      baseInput({ groupIds: [hiddenPackage.id] }),
      { child_listing_ids: [child.id] },
      null,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe(t("error.package_gate_in_hidden"));
    }
  });

  test("passes groupIds through from the input", async () => {
    const group = await createTestGroup({ name: "Join group" });

    const result = await prepareListingJoins(
      baseInput({ groupIds: [group.id] }),
      {},
      null,
    );

    expect(result).toEqual({
      value: {
        childEdges: null,
        dayPrices: undefined,
        groupIds: [group.id],
      },
    });
  });

  test("persistListingJoins writes group membership and child edges in one tx", async () => {
    const parent = await createTestListing({ name: "Persist parent" });
    const child = await createTestListing({ name: "Persist child" });
    const group = await createTestGroup({ name: "Persist group" });

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, parent.id, {
        childEdges: [child.id],
        dayPrices: undefined,
        groupIds: [group.id],
      });
    });

    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
    expect(await listingGroups.getIds(parent.id)).toEqual([group.id]);
  });

  test("persistListingJoins leaves existing edges untouched when childEdges is null", async () => {
    const parent = await createTestListing({ name: "Skip parent" });
    const child = await createTestListing({ name: "Skip child" });
    await listingChildren.setIds(parent.id, [child.id]);

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, parent.id, {
        childEdges: null,
        dayPrices: undefined,
        groupIds: undefined,
      });
    });

    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("persistListingJoins clears child edges when given an empty array", async () => {
    const parent = await createTestListing({ name: "Clear parent" });
    const child = await createTestListing({ name: "Clear child" });
    await listingChildren.setIds(parent.id, [child.id]);

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, parent.id, {
        childEdges: [],
        dayPrices: undefined,
        groupIds: undefined,
      });
    });

    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("persistListingJoins writes day prices before edge validation", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 2,
      listingType: "daily",
      name: "Changing daily parent",
    });
    const child = await createTestListing({
      durationDays: 2,
      listingType: "daily",
      name: "Two-day child",
    });

    await withTransaction((tx) =>
      persistListingJoins(tx, parent.id, {
        childEdges: [child.id],
        dayPrices: { 2: 1800 },
        groupIds: undefined,
      }),
    );

    expect(await getListingDayPrices(parent.id)).toEqual({ 2: 1800 });
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });
});
