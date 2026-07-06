import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  andPrefixed,
  emptyRange,
  occurredAtRange,
  wherePrefixed,
} from "#shared/accounting/range.ts";

describe("accounting > range", () => {
  describe("occurredAtRange", () => {
    test("the empty range yields no clause and no args", () => {
      expect(occurredAtRange(emptyRange)).toEqual({ args: [], clause: "" });
    });

    test("a lower bound alone is an inclusive >= predicate", () => {
      expect(occurredAtRange({ endMs: null, startMs: 100 })).toEqual({
        args: [100],
        clause: "occurred_at >= ?",
      });
    });

    test("an upper bound alone is an exclusive < predicate", () => {
      expect(occurredAtRange({ endMs: 200, startMs: null })).toEqual({
        args: [200],
        clause: "occurred_at < ?",
      });
    });

    test("both bounds AND together, lower first, in arg order", () => {
      expect(occurredAtRange({ endMs: 200, startMs: 100 })).toEqual({
        args: [100, 200],
        clause: "occurred_at >= ? AND occurred_at < ?",
      });
    });
  });

  describe("clause prefixing", () => {
    test("andPrefixed wraps a non-empty clause, passes through empty", () => {
      expect(andPrefixed("a = 1")).toBe(" AND a = 1");
      expect(andPrefixed("")).toBe("");
    });

    test("wherePrefixed wraps a non-empty clause, passes through empty", () => {
      expect(wherePrefixed("a = 1")).toBe(" WHERE a = 1");
      expect(wherePrefixed("")).toBe("");
    });
  });
});
