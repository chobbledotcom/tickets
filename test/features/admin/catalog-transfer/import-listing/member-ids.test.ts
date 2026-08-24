/**
 * Spotting a member that vanished between resolving names and the
 * transaction's own read.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { missingMemberId } from "#routes/admin/catalog-transfer/import-listing.ts";

const found = new Map([
  [1, {}],
  [3, {}],
]);

test("reports nothing when every member was found", () => {
  expect(missingMemberId([1, 3], found)).toBeNull();
  expect(missingMemberId([], found)).toBeNull();
});

test("reports the first member that is missing, not one that is present", () => {
  expect(missingMemberId([1, 2, 3], found)).toBe(2);
  // Two gaps: the earlier one is the one reported.
  expect(missingMemberId([2, 4], found)).toBe(2);
  expect(missingMemberId([4, 2], found)).toBe(4);
});
