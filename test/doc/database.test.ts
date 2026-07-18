import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getListingRemainingForRange,
  type ListingCapacityRow,
} from "#src/doc.ts";

const documentedCapacityLookup = getListingRemainingForRange satisfies (
  listings: ListingCapacityRow[],
  date: string | null,
  durationDays?: number,
) => Promise<Map<number, number>>;

test("exports the documented capacity range lookup", () => {
  expect(documentedCapacityLookup).toBe(getListingRemainingForRange);
});
