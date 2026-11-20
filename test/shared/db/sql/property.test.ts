// Property tests for the sql tag: for arbitrary values, each slot in the text
// names one argument, and each value comes back from the slot at its place.
// fast-check runs each property with a fixed seed and run count, so every run
// generates the same cases.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import { sql, sqlList } from "#db/sql.ts";

const seedArgs = { numRuns: 200, seed: 20261114 } as const;

/** Values with many repeats, and text that looks like a slot or like SQL. */
const arbitraryValues = (): fc.Arbitrary<(string | number | null)[]> =>
  fc.array(
    fc.oneof(
      fc.integer({ max: 3, min: 0 }),
      fc.constantFrom("?1", "?", "'; DROP TABLE x; --", "", "1"),
      fc.constant(null),
      fc.string(),
    ),
    { maxLength: 30 },
  );

/** The slot numbers in the text, in the order they are written. */
const slotNumbers = (text: string): number[] =>
  [...text.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));

describe("sql properties", () => {
  test("the slots are 1 to the argument count, with no gap", () => {
    fc.assert(
      fc.property(arbitraryValues(), (values) => {
        const statement = sql`SELECT ${sqlList(values)}`;
        expect([...new Set(slotNumbers(statement.sql))]).toEqual(
          statement.args.map((_arg, index) => index + 1),
        );
      }),
      seedArgs,
    );
  });

  test("each place reads back the value that was written there", () => {
    fc.assert(
      fc.property(arbitraryValues(), (values) => {
        const statement = sql`SELECT ${sqlList(values)}`;
        expect(
          slotNumbers(statement.sql).map((slot) => statement.args[slot - 1]),
        ).toEqual(values);
      }),
      seedArgs,
    );
  });

  test("no value changes the text around the slots", () => {
    fc.assert(
      fc.property(arbitraryValues(), (values) => {
        const { sql: text } = sql`SELECT ${sqlList(values)} FROM t`;
        expect(text.replaceAll(/\?\d+/g, "?")).toBe(
          `SELECT ${values.map(() => "?").join(", ")} FROM t`,
        );
      }),
      seedArgs,
    );
  });

  test("a statement inside another keeps the same values in the same places", () => {
    fc.assert(
      fc.property(arbitraryValues(), arbitraryValues(), (first, second) => {
        const whole = sql`${sqlList(first)} | ${sqlList(second)}`;
        expect(
          slotNumbers(whole.sql).map((slot) => whole.args[slot - 1]),
        ).toEqual([...first, ...second]);
      }),
      seedArgs,
    );
  });
});
