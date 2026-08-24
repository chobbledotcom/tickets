import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { emptyRange, occurredAtRange } from "#accounting/range.ts";
import { clauseArgs, whereSql } from "#db/where-clauses.ts";

describe("accounting > range", () => {
  describe("occurredAtRange", () => {
    test("the empty range constrains nothing", () => {
      expect(occurredAtRange(emptyRange)).toEqual([]);
    });

    test("a lower bound alone is an inclusive >= predicate", () => {
      expect(occurredAtRange({ endMs: null, startMs: 100 })).toEqual([
        { args: [100], clause: "occurred_at >= ?" },
      ]);
    });

    test("an upper bound alone is an exclusive < predicate", () => {
      expect(occurredAtRange({ endMs: 200, startMs: null })).toEqual([
        { args: [200], clause: "occurred_at < ?" },
      ]);
    });

    test("both bounds are separate clauses, lower first", () => {
      expect(occurredAtRange({ endMs: 200, startMs: 100 })).toEqual([
        { args: [100], clause: "occurred_at >= ?" },
        { args: [200], clause: "occurred_at < ?" },
      ]);
    });

    test("qualifies an explicitly named timestamp column", () => {
      expect(
        occurredAtRange({ endMs: 200, startMs: 100 }, "transfer.occurred_at"),
      ).toEqual([
        { args: [100], clause: "transfer.occurred_at >= ?" },
        { args: [200], clause: "transfer.occurred_at < ?" },
      ]);
    });

    test("builds the query tail with the args in clause order", () => {
      const parts = occurredAtRange({ endMs: 200, startMs: 100 });
      expect(whereSql(parts)).toBe(
        " WHERE occurred_at >= ? AND occurred_at < ?",
      );
      expect(clauseArgs(parts)).toEqual([100, 200]);
    });
  });
});
