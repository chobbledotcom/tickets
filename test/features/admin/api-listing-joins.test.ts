/** Direct unit tests for the listing join preparation and persistence
 *  extracted from api.ts. The API integration tests in api/regressions.test.ts
 *  exercise the full request path; these test the extracted functions
 *  directly so mutation testing has a mirror for api-listing-joins.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  persistListingJoins,
  prepareListingJoins,
} from "#routes/admin/api-listing-joins.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { withTransaction } from "#shared/db/client.ts";
import { listingGroups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const baseInput = (overrides: Partial<ListingInput> = {}): ListingInput =>
  ({
    name: "Test listing",
    ...overrides,
  }) as unknown as ListingInput;

describeWithEnv("api-listing-joins", { db: true }, () => {
  test("returns null child edges when child_listing_ids is omitted", async () => {
    const result = await prepareListingJoins(baseInput(), {}, null);

    expect(result).toEqual({
      value: { childEdges: null, groupIds: undefined },
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

  test("passes groupIds through from the input", async () => {
    const group = await createTestGroup({ name: "Join group" });

    const result = await prepareListingJoins(
      baseInput({ groupIds: [group.id] }),
      {},
      null,
    );

    expect(result).toEqual({
      value: { childEdges: null, groupIds: [group.id] },
    });
  });

  test("persistListingJoins writes group membership and child edges in one tx", async () => {
    const parent = await createTestListing({ name: "Persist parent" });
    const child = await createTestListing({ name: "Persist child" });
    const group = await createTestGroup({ name: "Persist group" });

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, parent.id, {
        childEdges: [child.id],
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
        groupIds: undefined,
      });
    });

    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });
});
