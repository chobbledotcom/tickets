import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { emptyRange, occurredAtRange } from "#accounting/range.ts";
import { whereTail } from "#db/select/expression.ts";
import { sql } from "#db/sql.ts";

describe("accounting > range", () => {
  describe("occurredAtRange", () => {
    test("the empty range constrains nothing", () => {
      expect(occurredAtRange(emptyRange)).toEqual([]);
    });

    test("a lower bound alone is an inclusive >= predicate", () => {
      expect(occurredAtRange({ endMs: null, startMs: 100 })).toEqual([
        sql`transfer.occurred_at >= ${100}`,
      ]);
    });

    test("an upper bound alone is an exclusive < predicate", () => {
      expect(occurredAtRange({ endMs: 200, startMs: null })).toEqual([
        sql`transfer.occurred_at < ${200}`,
      ]);
    });

    test("both bounds are separate clauses, lower first", () => {
      expect(occurredAtRange({ endMs: 200, startMs: 100 })).toEqual([
        sql`transfer.occurred_at >= ${100}`,
        sql`transfer.occurred_at < ${200}`,
      ]);
    });

    test("builds the query tail with the args in clause order", () => {
      const parts = occurredAtRange({ endMs: 200, startMs: 100 });
      expect(whereTail(parts)).toEqual(
        sql` WHERE transfer.occurred_at >= ${100} AND transfer.occurred_at < ${200}`,
      );
    });
  });
});
