/**
 * The rules the documentation checks are built on. "Blank" in particular is a
 * judgement call the documented examples alone do not exercise: no example
 * carries a negative number, which is exactly why it is worth pinning here.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_API_ENDPOINTS } from "#shared/admin-api-example.ts";
import { documented, freshTotals, isBlank, jsonLeaves } from "./helpers.ts";

describe("a value not worth documenting", () => {
  test("empty and whitespace-only text is blank", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank("   ")).toBe(true);
    expect(isBlank("Summer Workshop")).toBe(false);
  });

  test("a negative number is always blank", () => {
    expect(isBlank(-1, "unit_price")).toBe(true);
    expect(isBlank(-1, "quantity")).toBe(true);
  });

  test("zero is blank only where it counts something", () => {
    expect(isBlank(0, "quantity")).toBe(true);
    expect(isBlank(0, "maxPurchasable")).toBe(true);
    // A free item and an uncapped group are both real things to document.
    expect(isBlank(0, "unit_price")).toBe(false);
    expect(isBlank(0, "max_attendees")).toBe(false);
  });

  test("anything that is not text or a number is left alone", () => {
    expect(isBlank(true, "hidden")).toBe(false);
    expect(isBlank(null, "closes_at")).toBe(false);
  });
});

describe("reading a documented body", () => {
  test("every value is reported with where it sits", () => {
    expect(
      jsonLeaves({ members: [{ name: "Tent Pitch", quantity: 1 }] }, "GET /x"),
    ).toEqual([
      { field: "name", value: "Tent Pitch", where: "GET /x.members[0].name" },
      { field: "quantity", value: 1, where: "GET /x.members[0].quantity" },
    ]);
  });

  test("a value in a list keeps the name of the field holding it", () => {
    // group_ids: [0] must be judged as an id, not as "group_ids[0]".
    expect(jsonLeaves({ group_ids: [7] }, "POST /x")).toEqual([
      { field: "group_ids", value: 7, where: "POST /x.group_ids[0]" },
    ]);
  });

  test("a missing endpoint is named, not stumbled over", () => {
    expect(() =>
      documented(ADMIN_API_ENDPOINTS, "GET", "/api/nowhere"),
    ).toThrow("No documented endpoint for GET /api/nowhere");
  });

  test("only the totals a record actually has are zeroed", () => {
    expect(freshTotals({ income: 7500, name: "Summer Workshop" })).toEqual({
      income: 0,
    });
    expect(freshTotals({ name: "Christmas" })).toEqual({});
  });
});
