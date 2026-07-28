import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { toCanonicalIso } from "#shared/payment-helpers.ts";

test("has no time to give when the provider sent none", () => {
  expect(toCanonicalIso(undefined)).toBeUndefined();
});

test("puts a provider's time into the one form the books accept", () => {
  expect(toCanonicalIso("2026-07-26T12:00:00+00:00")).toBe(
    "2026-07-26T12:00:00.000Z",
  );
});

test("has no time to give when the provider sent something unreadable", () => {
  expect(toCanonicalIso("not a time")).toBeUndefined();
});
