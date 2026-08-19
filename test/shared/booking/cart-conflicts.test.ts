import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CartFacts,
  cartConflictMessages,
} from "#booking/cart-conflicts.ts";
import { t } from "#i18n";

/** Facts with no length items unless a test supplies them. */
const facts = (over: Partial<CartFacts>): CartFacts => ({
  dateItems: [],
  lengthItems: [],
  ...over,
});

describe("cartConflictMessages", () => {
  test("an empty page has no conflicts", () => {
    expect(cartConflictMessages(facts({}))).toEqual([]);
  });

  test("a single item with no dates is not a cart conflict", () => {
    // The date selector's own "no dates" copy already covers it.
    expect(
      cartConflictMessages(
        facts({ dateItems: [{ dates: [], id: 1, name: "Hall" }] }),
      ),
    ).toEqual([]);
  });

  test("names the item with no dates instead of blaming the mix", () => {
    expect(
      cartConflictMessages(
        facts({
          dateItems: [
            { dates: ["2026-09-01"], id: 1, name: "Hall" },
            { dates: [], id: 2, name: "Boat" },
          ],
        }),
      ),
    ).toEqual([
      t("public.ticket.cart_item_no_dates", { count: 1, names: "'Boat'" }),
    ]);
  });

  test("stays quiet when every item is dateless — there are no others to book", () => {
    // The selectors' plain "no dates" copy covers a fully dead page; naming
    // items and saying "book the others" would be an impossible instruction.
    expect(
      cartConflictMessages(
        facts({
          dateItems: [
            { dates: [], id: 1, name: "Hall" },
            { dates: [], id: 2, name: "Boat" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("names every item with no dates, in one plural message", () => {
    expect(
      cartConflictMessages(
        facts({
          dateItems: [
            { dates: ["2026-09-01"], id: 1, name: "Hall" },
            { dates: [], id: 2, name: "Boat" },
            { dates: [], id: 3, name: "Marquee" },
          ],
        }),
      ),
    ).toEqual([
      t("public.ticket.cart_item_no_dates", {
        count: 2,
        names: "'Boat' and 'Marquee'",
      }),
    ]);
  });

  test("names every item when each has dates but none are shared", () => {
    expect(
      cartConflictMessages(
        facts({
          dateItems: [
            { dates: ["2026-09-01", "2026-09-02"], id: 1, name: "Hall" },
            { dates: ["2026-09-02", "2026-09-03"], id: 2, name: "Boat" },
            { dates: ["2026-09-04"], id: 3, name: "Marquee" },
          ],
        }),
      ),
    ).toEqual([
      t("public.ticket.cart_no_shared_date", {
        names: "'Hall', 'Boat', and 'Marquee'",
      }),
    ]);
  });

  test("stays quiet when the items share a date", () => {
    expect(
      cartConflictMessages(
        facts({
          dateItems: [
            { dates: ["2026-09-01", "2026-09-02"], id: 1, name: "Hall" },
            { dates: ["2026-09-02"], id: 2, name: "Boat" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("names every item when no booking length suits them all", () => {
    expect(
      cartConflictMessages(
        facts({
          lengthItems: [
            { dayCounts: [1, 2], name: "Tent" },
            { dayCounts: [3], name: "Yurt" },
          ],
        }),
      ),
    ).toEqual([
      t("public.ticket.cart_no_shared_length", { names: "'Tent' and 'Yurt'" }),
    ]);
  });

  test("stays quiet when the items share a booking length", () => {
    expect(
      cartConflictMessages(
        facts({
          lengthItems: [
            { dayCounts: [1, 2], name: "Tent" },
            { dayCounts: [2, 3], name: "Yurt" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("a single customisable item is not a length conflict", () => {
    expect(
      cartConflictMessages(
        facts({ lengthItems: [{ dayCounts: [2], name: "Tent" }] }),
      ),
    ).toEqual([]);
  });

  test("lists a date conflict and a length conflict together, dates first", () => {
    expect(
      cartConflictMessages({
        dateItems: [
          { dates: ["2026-09-01"], id: 1, name: "Hall" },
          { dates: ["2026-09-02"], id: 2, name: "Boat" },
        ],
        lengthItems: [
          { dayCounts: [1], name: "Hall" },
          { dayCounts: [2], name: "Boat" },
        ],
      }),
    ).toEqual([
      t("public.ticket.cart_no_shared_date", { names: "'Hall' and 'Boat'" }),
      t("public.ticket.cart_no_shared_length", { names: "'Hall' and 'Boat'" }),
    ]);
  });
});
