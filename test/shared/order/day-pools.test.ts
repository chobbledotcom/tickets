/**
 * The order evaluator's per-day pool rules: each option judged over the days
 * its own booking occupies, and the blocked-by label naming the selection
 * that holds the exact short day.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { evaluateOrder, kindsOf, option, pools } from "./evaluate-helpers.ts";

describe("evaluateOrder — day pools", () => {
  test("names the selection holding the short day, not any pool sharer", () => {
    // One shared listing pool with remaining [3, 1] over two days. A books
    // its start day only; B and C each book both days. After A then B, the
    // shortage is day two alone — and only B's removal frees it, so the
    // blocker must name B, though A also draws from the same pool.
    const twoDays = pools({
      days: ["2026-03-02", "2026-03-03"],
      remainingByListingDay: new Map([
        [
          7,
          new Map([
            ["2026-03-02", 3],
            ["2026-03-03", 1],
          ]),
        ],
      ]),
    });
    const inGroup = (key: string, name: string, span: number) =>
      option(key, [[7, 1]], {
        alternatives: [
          {
            spanDaysByListingId: new Map([[7, span]]),
            unitsByListingId: new Map([[7, 1]]),
          },
        ],
        name,
        spanDaysByListingId: new Map([[7, span]]),
      });
    const states = evaluateOrder(
      [
        inGroup("listing:1", "One Day Trip", 1),
        inGroup("listing:2", "Two Day Trip", 2),
        inGroup("listing:3", "Rival Trip", 2),
      ],
      twoDays,
      ["listing:1", "listing:2"],
      true,
    );
    expect(states.get("listing:3")).toEqual({
      byKey: "listing:2",
      byName: "Two Day Trip",
      kind: "blocked",
    });
    // Removing the named blocker frees the short day: C fits beside A.
    const withoutBlocker = evaluateOrder(
      [
        inGroup("listing:1", "One Day Trip", 1),
        inGroup("listing:3", "Rival Trip", 2),
      ],
      twoDays,
      ["listing:1"],
      true,
    );
    expect(withoutBlocker.get("listing:3")).toEqual({ kind: "available" });
  });

  describe("spans", () => {
    const start = "2026-03-02";
    /** Listing 1 has one unit left on the start day and `unitsAfterStart` the
     * day after. */
    const dayPools = (unitsAfterStart: number) =>
      pools({
        days: [start, "2026-03-03"],
        remainingByListingDay: new Map([
          [
            1,
            new Map([
              [start, 1],
              ["2026-03-03", unitsAfterStart],
            ]),
          ],
        ]),
      });
    /** The same pair of options judged over different spans of listing 1. */
    const oneDay = option("listing:1", [[1, 1]], {
      alternatives: [
        {
          spanDaysByListingId: new Map([[1, 1]]),
          unitsByListingId: new Map([[1, 1]]),
        },
      ],
      name: "One Day Trip",
      spanDaysByListingId: new Map([[1, 1]]),
    });
    const twoDay = option("listing:2", [[1, 1]], {
      alternatives: [
        {
          spanDaysByListingId: new Map([[1, 2]]),
          unitsByListingId: new Map([[1, 1]]),
        },
      ],
      name: "Two Day Trip",
      spanDaysByListingId: new Map([[1, 2]]),
    });

    test("a demand judged over one day fits where a longer span cannot", () => {
      // The same shared listing pool: one option takes a unit on the start
      // day only, the other's booking occupies both days. The first fits,
      // the second never does — each judged over its own span.
      const states = evaluateOrder([oneDay, twoDay], dayPools(0), [], true);
      expect(kindsOf(states)).toEqual({
        "listing:1": "available",
        "listing:2": "unavailable",
      });
    });

    test("a committed short span still holds only its own days", () => {
      // The selected one-day booking takes the start day's unit; a later
      // two-day option is blocked by it (the day after was already full),
      // while the committed demand never reaches into days its own span
      // does not occupy.
      const states = evaluateOrder(
        [oneDay, twoDay],
        dayPools(1),
        ["listing:1"],
        true,
      );
      expect(states.get("listing:1")).toEqual({ kind: "selected" });
      expect(states.get("listing:2")).toEqual({
        byKey: "listing:1",
        byName: "One Day Trip",
        kind: "blocked",
      });
    });

    test("an option without a declared span judges the start day alone", () => {
      // A day-judged pool with no span on the option: the demand reads the
      // start day alone.
      const states = evaluateOrder(
        [option("listing:1", [[1, 1]])],
        dayPools(0),
        [],
        true,
      );
      expect(states.get("listing:1")).toEqual({ kind: "available" });
    });
  });
});
