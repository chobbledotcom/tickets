/** Direct tests for the modifier split the ticket cards show. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { splitModifiersAcrossCards } from "#routes/tickets/modifier-shares.ts";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

/** One booking card in the given order, with the given ticket count. */
const card = (
  quantity: number,
  ledgerEventGroup = "evt-order",
): TokenEntry => ({
  ...testTokenEntry({ attendee: { quantity } }),
  ledgerEventGroup,
});

describe("splitModifiersAcrossCards", () => {
  test("gives one card its order's whole modifier", () => {
    const entry = card(3);
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

  test("splits a modifier across an order's cards by ticket count", () => {
    const small = card(1);
    const large = card(3);
    const shares = splitModifiersAcrossCards(
      [small, large],
      new Map([["evt-order", [{ amount: 1000, name: "Service charge" }]]]),
    );
    expect(shares.get(small)).toEqual([
      { amount: 250, name: "Service charge" },
    ]);
    expect(shares.get(large)).toEqual([
      { amount: 750, name: "Service charge" },
    ]);
  });

  test("keeps a discount's sign on every share", () => {
    const cards = [card(1), card(1), card(1)];
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
    const single = card(1);
    const many = card(99);
    const shares = splitModifiersAcrossCards(
      [single, many],
      new Map([["evt-order", [{ amount: 2, name: "Service charge" }]]]),
    );
    expect(shares.get(single)).toEqual([]);
    expect(shares.get(many)).toEqual([{ amount: 2, name: "Service charge" }]);
  });

  test("keeps a merged attendee's two orders apart", () => {
    const first = card(1, "evt-first");
    const second = card(1, "evt-second");
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
    const entry = card(2, "evt-plain");
    const shares = splitModifiersAcrossCards(
      [entry],
      new Map([["evt-other", [{ amount: 100, name: "Other charge" }]]]),
    );
    expect(shares.get(entry)).toEqual([]);
  });
});
