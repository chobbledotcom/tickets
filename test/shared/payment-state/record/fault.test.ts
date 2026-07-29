import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  absent,
  allAbsent,
  firstFault,
  firstOf,
  present,
} from "#shared/payment-state/record/fault.ts";

describe("saying what is wrong with a record", () => {
  test("says nothing when every rule holds", () => {
    expect(
      firstFault([
        [true, "first"],
        [true, "second"],
      ]),
    ).toBe(null);
  });

  test("says the first rule that did not hold, not a later one", () => {
    // Order matters: the reader is told the earliest thing wrong, so a rule
    // that only fails because an earlier one did cannot mask it.
    expect(
      firstFault([
        [true, "held"],
        [false, "broke first"],
        [false, "broke later"],
      ]),
    ).toBe("broke first");
  });

  test("says nothing about an empty list of rules", () => {
    expect(firstFault([])).toBe(null);
  });
});

describe("picking between several answers", () => {
  test("says nothing when every answer found nothing", () => {
    expect(firstOf(null, null)).toBe(null);
  });

  test("says the first answer that found something", () => {
    expect(firstOf(null, "second said so", "third said so")).toBe(
      "second said so",
    );
  });

  test("says nothing when there are no answers at all", () => {
    expect(firstOf()).toBe(null);
  });
});

describe("whether a value is there", () => {
  // Zero, an empty string, and false are all real values a record may hold, so
  // "there" cannot mean "truthy" — only missing counts as missing.
  for (const value of [0, "", false, [], Number.NaN] as const) {
    test(`counts ${JSON.stringify(value) ?? "NaN"} as being there`, () => {
      expect(present(value)).toBe(true);
      expect(absent(value)).toBe(false);
    });
  }

  for (const [name, value] of [
    ["nothing", null],
    ["not set at all", undefined],
  ] as const) {
    test(`counts ${name} as missing`, () => {
      expect(present(value)).toBe(false);
      expect(absent(value)).toBe(true);
    });
  }

  test("says a list of missing values is all missing", () => {
    expect(allAbsent([null, undefined])).toBe(true);
  });

  test("says a list is not all missing when one value is there", () => {
    expect(allAbsent([null, 0, undefined])).toBe(false);
  });

  test("says an empty list is all missing", () => {
    expect(allAbsent([])).toBe(true);
  });
});
