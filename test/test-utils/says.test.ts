import { assertThrows } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { has, hasNot, says, saysNot } from "#test-utils/says.ts";

/** The helpers answer the way the removed `toContain` override answered:
 * a nullish text or list never holds the part, so `says` and `has` fail,
 * and `saysNot` fails too, because absence was never proven. */
describe("the says helpers", () => {
  test("says passes when the text holds the part", () => {
    says("abcdef", "cde");
  });

  test("says fails when the text leaves the part out or is nullish", () => {
    assertThrows(() => says("abcdef", "xyz"));
    assertThrows(() => says(undefined, "cde"));
    assertThrows(() => says(null, "cde"));
  });

  test("saysNot passes when the text leaves the part out", () => {
    saysNot("abcdef", "xyz");
  });

  test("saysNot fails when the text holds the part or is nullish", () => {
    assertThrows(() => saysNot("abcdef", "cde"));
    assertThrows(() => saysNot(undefined, "xyz"));
    assertThrows(() => saysNot(null, "xyz"));
  });

  test("has passes when the list holds the item", () => {
    has([1, 2, 3], 2);
  });

  test("has fails when the list leaves the item out or is nullish", () => {
    assertThrows(() => has([1, 2, 3], 9));
    assertThrows(() => has(undefined, 2));
    assertThrows(() => has(null, 2));
  });

  test("hasNot passes when the list leaves the item out", () => {
    hasNot([1, 2, 3], 9);
  });

  test("hasNot fails when the list holds the item or is nullish", () => {
    assertThrows(() => hasNot([1, 2, 3], 2));
    assertThrows(() => hasNot(undefined, 9));
    assertThrows(() => hasNot(null, 9));
  });
});
