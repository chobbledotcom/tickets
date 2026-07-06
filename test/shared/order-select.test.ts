import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  orderedSelectionKeys,
  parseSelectedListingIds,
  parseSelectedPackageIds,
  SELECT_PREFIX,
  selectedListingQuantities,
  selectedStartDate,
} from "#shared/order-select.ts";

describe("parseSelectedListingIds", () => {
  test("extracts selected listing ids in ascending order", () => {
    const params = new URLSearchParams(
      "select_8=1&select_3=1&start_date=2026-01-01",
    );
    expect(parseSelectedListingIds(params)).toEqual([3, 8]);
  });

  test("ignores values other than 1", () => {
    const params = new URLSearchParams("select_3=0&select_4=yes&select_5=1");
    expect(parseSelectedListingIds(params)).toEqual([5]);
  });

  test("ignores non-numeric, partly-numeric and non-positive ids", () => {
    const params = new URLSearchParams(
      `${SELECT_PREFIX}abc=1&${SELECT_PREFIX}0=1&${SELECT_PREFIX}-2=1&${SELECT_PREFIX}5abc=1&${SELECT_PREFIX}6=1`,
    );
    // "5abc" is rejected outright — strict id parsing, not lenient parseInt.
    expect(parseSelectedListingIds(params)).toEqual([6]);
  });

  test("de-duplicates repeated ids", () => {
    const params = new URLSearchParams("select_7=1&select_7=1");
    expect(parseSelectedListingIds(params)).toEqual([7]);
  });

  test("returns an empty array when nothing is selected", () => {
    expect(parseSelectedListingIds(new URLSearchParams("foo=bar"))).toEqual([]);
  });

  test("never reads a package selection as a listing id", () => {
    const params = new URLSearchParams("select_package_7=1&select_3=1");
    expect(parseSelectedListingIds(params)).toEqual([3]);
  });
});

describe("parseSelectedPackageIds", () => {
  test("extracts selected package group ids, ignoring listing selections", () => {
    const params = new URLSearchParams(
      "select_package_9=1&select_package_2=1&select_5=1&select_package_0=1",
    );
    expect(parseSelectedPackageIds(params)).toEqual([2, 9]);
  });
});

describe("orderedSelectionKeys", () => {
  test("orders selected keys by the order field, appending the rest", () => {
    const params = new URLSearchParams(
      "select_3=1&select_8=1&select_package_7=1&order=package:7,listing:8",
    );
    expect(orderedSelectionKeys(params)).toEqual([
      "package:7",
      "listing:8",
      "listing:3",
    ]);
  });

  test("a tampered order value can neither add nor keep an unselected key", () => {
    const params = new URLSearchParams(
      "select_3=1&order=listing:99,listing:3,listing:3",
    );
    expect(orderedSelectionKeys(params)).toEqual(["listing:3"]);
  });

  test("falls back to id order without an order field", () => {
    const params = new URLSearchParams(
      "select_8=1&select_3=1&select_package_7=1",
    );
    expect(orderedSelectionKeys(params)).toEqual([
      "listing:3",
      "listing:8",
      "package:7",
    ]);
  });
});

describe("selectedListingQuantities", () => {
  test("maps every selected listing to the default admin-create quantity", () => {
    const params = new URLSearchParams("select_8=1&select_3=1");
    expect([...selectedListingQuantities(params)]).toEqual([
      [3, 1],
      [8, 1],
    ]);
  });
});

describe("selectedStartDate", () => {
  test("returns the selected ISO date", () => {
    const params = new URLSearchParams("start_date=2026-07-01");
    expect(selectedStartDate(params)).toBe("2026-07-01");
  });

  test("returns blank for missing or invalid dates", () => {
    expect(selectedStartDate(new URLSearchParams())).toBe("");
    expect(selectedStartDate(new URLSearchParams("start_date=tomorrow"))).toBe(
      "",
    );
  });
});
