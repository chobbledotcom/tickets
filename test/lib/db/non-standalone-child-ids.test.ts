import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  anyNonStandaloneChild,
  getNonStandaloneChildIds,
  setChildIds,
} from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

describeWithEnv(
  "db > listing-parents > getNonStandaloneChildIds",
  { db: true },
  () => {
    /** A parent with one child; the child's bookable_alone is set per test. */
    const parentWithChild = async (bookableAlone: boolean) => {
      const parent = await createTestListing({ name: "Picker" });
      const child = await createTestListing({ name: "Widget" });
      await setChildIds(parent.id, [child.id]);
      if (bookableAlone) {
        await listingsTable.update(child.id, { bookableAlone: true });
      }
      return { child, parent };
    };

    test("a plain child (bookable_alone = 0) IS non-standalone", async () => {
      const { child } = await parentWithChild(false);
      const ids = await getNonStandaloneChildIds([child.id]);
      expect(ids.has(child.id)).toBe(true);
      expect(await anyNonStandaloneChild([child.id])).toBe(true);
    });

    test("a bookable_alone child is EXCLUDED — it keeps a standalone page", async () => {
      const { child } = await parentWithChild(true);
      // Still a child (has parent edges) so getChildListingIds would include it,
      // but the narrowed gate predicate drops it: its own page is allowed.
      const ids = await getNonStandaloneChildIds([child.id]);
      expect(ids.has(child.id)).toBe(false);
      expect(await anyNonStandaloneChild([child.id])).toBe(false);
    });

    test("a non-child listing is never in the set", async () => {
      const solo = await createTestListing({ name: "Solo" });
      expect((await getNonStandaloneChildIds([solo.id])).size).toBe(0);
      expect(await anyNonStandaloneChild([solo.id])).toBe(false);
    });

    test("mixes plain and flagged children in one call", async () => {
      const { child: plain } = await parentWithChild(false);
      const { child: flagged } = await parentWithChild(true);
      const ids = await getNonStandaloneChildIds([plain.id, flagged.id]);
      expect([...ids]).toEqual([plain.id]);
      // The call reports true because at least one is non-standalone.
      expect(await anyNonStandaloneChild([plain.id, flagged.id])).toBe(true);
    });

    test("empty input short-circuits with no query", async () => {
      expect((await getNonStandaloneChildIds([])).size).toBe(0);
      expect(await anyNonStandaloneChild([])).toBe(false);
    });
  },
);
