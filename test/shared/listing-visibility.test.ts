import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isPublicListing } from "#shared/listing-visibility.ts";

describe("listing visibility", () => {
  const cases = [
    { active: true, expected: true, hidden: false },
    { active: false, expected: false, hidden: false },
    { active: true, expected: false, hidden: true },
  ];

  for (const { active, expected, hidden } of cases) {
    test(`active ${active}, hidden ${hidden} is ${expected}`, () => {
      expect(isPublicListing({ active, hidden })).toBe(expected);
    });
  }
});
