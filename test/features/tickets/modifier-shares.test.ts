/** Direct tests for the modifier split the ticket cards show. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sumOf } from "#fp";
import {
  type ModifierLine,
  splitModifiersAcrossCards,
} from "#routes/tickets/modifier-shares.ts";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

/** One booking card in the given order: the ticket count it holds and the
 *  ticket income its price line shows. */
const card = (
  quantity: number,
  income = 0,
  ledgerEventGroup = "evt-order",
): TokenEntry => ({
  ...testTokenEntry({ attendee: { price_paid: String(income), quantity } }),
  ledgerEventGroup,
});

describe("splitModifiersAcrossCards", () => {
  test("gives one card its order's whole modifier", () => {
    const entry = card(3, 3000);
    const shares = splitModifiersAcrossCards(
      [entry],
      new Map([
        [
          "evt-order",
          [
            { amount: 500, name: "Service charge" },
            { amount: -200, name: "Early bird" },
          ],
        ],
      ]),
    );
    expect(shares.get(entry)).toEqual([
      { amount: 500, name: "Service charge" },
      { amount: -200, name: "Early bird" },
    ]);
  });

  test("follows each card's ticket income", () => {
    const costly = card(1, 10_000);
    const cheap = card(1, 1000);
    const shares = splitModifiersAcrossCards(
      [costly, cheap],
      new Map([["evt-order", [{ amount: 1100, name: "Service charge" }]]]),
    );
    expect(shares.get(costly)).toEqual([
      { amount: 1000, name: "Service charge" },
    ]);
    expect(shares.get(cheap)).toEqual([
      { amount: 100, name: "Service charge" },
    ]);
  });

  test("follows the ticket count when the order earned nothing", () => {
    const single = card(1);
    const many = card(99);
    const shares = splitModifiersAcrossCards(
      [single, many],
      new Map([["evt-order", [{ amount: 100, name: "Service charge" }]]]),
    );
    expect(shares.get(single)).toEqual([{ amount: 1, name: "Service charge" }]);
    expect(shares.get(many)).toEqual([{ amount: 99, name: "Service charge" }]);
  });

  test("keeps a discount's sign on every share", () => {
    const cards = [card(1, 1000), card(1, 1000), card(1, 1000)];
    const shares = splitModifiersAcrossCards(
      cards,
      new Map([["evt-order", [{ amount: -1000, name: "Early bird" }]]]),
    );
    // The leftover penny rides on the first card, so the shares still add up.
    expect(cards.map((entry) => shares.get(entry))).toEqual([
      [{ amount: -334, name: "Early bird" }],
      [{ amount: -333, name: "Early bird" }],
      [{ amount: -333, name: "Early bird" }],
    ]);
  });

  test("leaves out a share that rounds to zero", () => {
    const tiny = card(1, 100);
    const large = card(1, 9900);
    const shares = splitModifiersAcrossCards(
      [tiny, large],
      new Map([["evt-order", [{ amount: 2, name: "Service charge" }]]]),
    );
    expect(shares.get(tiny)).toEqual([]);
    expect(shares.get(large)).toEqual([{ amount: 2, name: "Service charge" }]);
  });

  test("keeps a merged attendee's two orders apart", () => {
    const first = card(1, 1000, "evt-first");
    const second = card(1, 9000, "evt-second");
    const shares = splitModifiersAcrossCards(
      [first, second],
      new Map([
        ["evt-first", [{ amount: 300, name: "First order charge" }]],
        ["evt-second", [{ amount: 500, name: "Second order charge" }]],
      ]),
    );
    expect(shares.get(first)).toEqual([
      { amount: 300, name: "First order charge" },
    ]);
    expect(shares.get(second)).toEqual([
      { amount: 500, name: "Second order charge" },
    ]);
  });

  test("shows no modifier for an order the ledger read omits", () => {
    const entry = card(2, 2000, "evt-plain");
    const shares = splitModifiersAcrossCards(
      [entry],
      new Map([["evt-other", [{ amount: 100, name: "Other charge" }]]]),
    );
    expect(shares.get(entry)).toEqual([]);
  });

  // Each modifier was charged once for the whole order, so the shares the
  // cards show must still add up to that figure once rounded to pennies, and
  // no card may show more discount than its own price.
  const roundedCases: readonly {
    amount: number;
    incomes: readonly number[];
    label: string;
  }[] = [
    { amount: 1000, incomes: [1000, 1000, 1000], label: "equal prices" },
    { amount: 7, incomes: [333, 667], label: "a small charge" },
    { amount: -401, incomes: [999, 1, 40_000], label: "a discount" },
    { amount: 200, incomes: [0, 0, 0], label: "a free order" },
  ];
  for (const { amount, incomes, label } of roundedCases) {
    test(`rounds ${label} without losing a penny`, () => {
      const cards = incomes.map((income) => card(1, income));
      const shares = splitModifiersAcrossCards(
        cards,
        new Map([["evt-order", [{ amount, name: "Service charge" }]]]),
      );
      const shown = cards.flatMap((entry) => shares.get(entry)!);
      expect(shown.map((line) => line.amount).every(Number.isInteger)).toBe(
        true,
      );
      expect(sumOf((line: ModifierLine) => line.amount)(shown)).toBe(amount);
      const totals = cards.map(
        (entry, index) =>
          incomes[index]! +
          sumOf((line: ModifierLine) => line.amount)(shares.get(entry)!),
      );
      expect(totals.every((total) => total >= 0)).toBe(true);
    });
  }
});
