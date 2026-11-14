import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { emptyRange, occurredAtRange } from "#accounting/range.ts";
import { sql } from "#db/sql.ts";
import { whereSql } from "#db/where-clauses.ts";

describe("accounting > range", () => {
  describe("occurredAtRange", () => {
    test("the empty range constrains nothing", () => {
      expect(occurredAtRange(emptyRange)).toEqual([]);
    });

    test("a lower bound alone is an inclusive >= predicate", () => {
      expect(occurredAtRange({ endMs: null, startMs: 100 })).toEqual([
        { clause: sql`occurred_at >= ${100}` },
      ]);
    });

    test("an upper bound alone is an exclusive < predicate", () => {
      expect(occurredAtRange({ endMs: 200, startMs: null })).toEqual([
        { clause: sql`occurred_at < ${200}` },
      ]);
    });

    test("both bounds are separate clauses, lower first", () => {
      expect(occurredAtRange({ endMs: 200, startMs: 100 })).toEqual([
        { clause: sql`occurred_at >= ${100}` },
        { clause: sql`occurred_at < ${200}` },
      ]);
    });

    test("qualifies an explicitly named timestamp column", () => {
      expect(
        occurredAtRange({ endMs: 200, startMs: 100 }, "transfer.occurred_at"),
      ).toEqual([
        { clause: sql`transfer.occurred_at >= ${100}` },
        { clause: sql`transfer.occurred_at < ${200}` },
      ]);
    });

    test("builds the query tail with the args in clause order", () => {
      const parts = occurredAtRange({ endMs: 200, startMs: 100 });
      expect(whereSql(parts)).toEqual(
        sql` WHERE occurred_at >= ${100} AND occurred_at < ${200}`,
      );
    });
  });
});
