import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { evaluateOrder } from "#shared/order/evaluate.ts";
import {
  listingOption,
  type OrderOption,
  type OrderPools,
  packageOption,
} from "#shared/order/options.ts";

/** An order option with every field defaulted to the simplest bookable shape. */
const option = (
  key: string,
  units: [number, number][],
  over: Partial<OrderOption> = {},
): OrderOption => ({
  bookableAlone: true,
  key,
  name: key,
  needsDate: false,
  unitsByListingId: new Map(units),
  ...over,
});

const pools = (over: Partial<OrderPools> = {}): OrderPools => ({
  groupIdsByListingId: new Map(),
  remainingByGroupId: new Map(),
  remainingByListingId: new Map(),
  ...over,
});

const kindsOf = (states: Map<string, { kind: string }>) =>
  Object.fromEntries([...states].map(([key, state]) => [key, state.kind]));

describe("listingOption", () => {
  test("books one unit of the listing under its own key", () => {
    const built = listingOption(
      { id: 5, listing_type: "standard", name: "Face Painting" },
      true,
    );
    expect(built.key).toBe("listing:5");
    expect(built.name).toBe("Face Painting");
    expect(built.bookableAlone).toBe(true);
    expect(built.needsDate).toBe(false);
    expect([...built.unitsByListingId]).toEqual([[5, 1]]);
  });

  test("a daily listing needs a date; bookability passes through", () => {
    const built = listingOption(
      { id: 5, listing_type: "daily", name: "Bouncy Castle" },
      false,
    );
    expect(built.needsDate).toBe(true);
    expect(built.bookableAlone).toBe(false);
  });
});

describe("packageOption", () => {
  test("books every member at its per-package quantity, defaulting to 1", () => {
    const built = packageOption(
      { id: 7, name: "Party Bundle" },
      [
        { id: 1, listing_type: "standard" },
        { id: 2, listing_type: "standard" },
      ],
      new Map([[1, 3]]),
      true,
    );
    expect(built.key).toBe("package:7");
    expect(built.name).toBe("Party Bundle");
    expect(built.needsDate).toBe(false);
    expect([...built.unitsByListingId]).toEqual([
      [1, 3],
      [2, 1],
    ]);
  });

  test("needs a date when any member is daily", () => {
    const built = packageOption(
      { id: 7, name: "Party Bundle" },
      [
        { id: 1, listing_type: "standard" },
        { id: 2, listing_type: "daily" },
      ],
      new Map(),
      true,
    );
    expect(built.needsDate).toBe(true);
  });
});

describe("evaluateOrder — plain availability", () => {
  test("options fit when pools cover them, including an exact fit", () => {
    const states = evaluateOrder(
      [option("listing:1", [[1, 1]]), option("listing:2", [[2, 1]])],
      pools({
        remainingByListingId: new Map([
          [1, 1],
          [2, 5],
        ]),
      }),
      [],
      false,
    );
    expect(kindsOf(states)).toEqual({
      "listing:1": "available",
      "listing:2": "available",
    });
  });

  test("a listing absent from every pool is unlimited", () => {
    const states = evaluateOrder(
      [option("listing:9", [[9, 4]])],
      pools(),
      [],
      false,
    );
    expect(states.get("listing:9")).toEqual({ kind: "available" });
  });

  test("an option that never fits today is unavailable, not blocked", () => {
    const states = evaluateOrder(
      [option("listing:1", [[1, 1]])],
      pools({ remainingByListingId: new Map([[1, 0]]) }),
      [],
      false,
    );
    expect(states.get("listing:1")).toEqual({ kind: "unavailable" });
  });

  test("an option that is not bookable alone is unavailable despite stock", () => {
    const states = evaluateOrder(
      [option("listing:1", [[1, 1]], { bookableAlone: false })],
      pools({ remainingByListingId: new Map([[1, 5]]) }),
      [],
      false,
    );
    expect(states.get("listing:1")).toEqual({ kind: "unavailable" });
  });
});

describe("evaluateOrder — dates", () => {
  test("a date-needing option waits for a date, then is judged", () => {
    const daily = option("listing:1", [[1, 1]], { needsDate: true });
    const poolset = pools({ remainingByListingId: new Map([[1, 0]]) });
    expect(evaluateOrder([daily], poolset, [], false).get("listing:1")).toEqual(
      { kind: "needs_date" },
    );
    expect(evaluateOrder([daily], poolset, [], true).get("listing:1")).toEqual({
      kind: "unavailable",
    });
  });
});

describe("evaluateOrder — selections and cart order", () => {
  const bundle = (key: string, name: string) => option(key, [[1, 1]], { name });

  /** Evaluate with listing 1's pool holding `left` units (no date chosen). */
  const judgeOnePool = (
    options: OrderOption[],
    left: number,
    selectedKeys: string[],
  ) =>
    evaluateOrder(
      options,
      pools({ remainingByListingId: new Map([[1, left]]) }),
      selectedKeys,
      false,
    );

  const blockedByParty = {
    byKey: "package:7",
    byName: "Party Bundle",
    kind: "blocked",
  };

  test("a selected option reports selected", () => {
    const states = judgeOnePool([option("listing:1", [[1, 1]])], 1, [
      "listing:1",
    ]);
    expect(states.get("listing:1")).toEqual({ kind: "selected" });
  });

  test("unknown selected keys are ignored", () => {
    const states = judgeOnePool([option("listing:1", [[1, 1]])], 1, [
      "listing:999",
    ]);
    expect(states.get("listing:1")).toEqual({ kind: "available" });
    expect(states.size).toBe(1);
  });

  test("an earlier selection blocks a later option and is named", () => {
    const states = judgeOnePool(
      [bundle("package:7", "Party Bundle"), option("listing:1", [[1, 1]])],
      1,
      ["package:7"],
    );
    expect(states.get("package:7")).toEqual({ kind: "selected" });
    expect(states.get("listing:1")).toEqual(blockedByParty);
  });

  test("overlap alone is no conflict — both paths book while stock covers them", () => {
    // Two bundles and the listing's own card all book listing 1. With three
    // units left, selecting two paths still leaves the third available.
    const states = judgeOnePool(
      [
        bundle("package:7", "Party Bundle"),
        bundle("package:8", "Deluxe Bundle"),
        option("listing:1", [[1, 1]]),
      ],
      3,
      ["package:7", "listing:1"],
    );
    expect(kindsOf(states)).toEqual({
      "listing:1": "selected",
      "package:7": "selected",
      "package:8": "available",
    });
  });

  test("blocking names the earliest committed selection on the short pool", () => {
    const states = judgeOnePool(
      [
        bundle("package:7", "Party Bundle"),
        option("listing:1", [[1, 1]], { name: "Face Painting" }),
        bundle("package:8", "Deluxe Bundle"),
      ],
      2,
      ["package:7", "listing:1"],
    );
    expect(states.get("package:8")).toEqual(blockedByParty);
  });

  test("a selection that no longer fits still counts against the cart", () => {
    // Both selections claim the single unit: the booking page is the
    // authority, so both stay selected and later options see the full demand.
    const states = judgeOnePool(
      [
        bundle("package:7", "Party Bundle"),
        option("listing:1", [[1, 1]]),
        bundle("package:8", "Deluxe Bundle"),
      ],
      1,
      ["package:7", "listing:1"],
    );
    expect(states.get("listing:1")).toEqual({ kind: "selected" });
    expect(states.get("package:8")).toEqual(blockedByParty);
  });

  test("a selection that cannot book alone holds no capacity", () => {
    const states = judgeOnePool(
      [
        option("package:7", [[1, 1]], { bookableAlone: false }),
        option("listing:1", [[1, 1]]),
      ],
      1,
      ["package:7"],
    );
    expect(states.get("package:7")).toEqual({ kind: "selected" });
    expect(states.get("listing:1")).toEqual({ kind: "available" });
  });

  test("a selection leaves unrelated pools exactly as they were", () => {
    // Listing 2's pool is empty from the start; committing listing 1's demand
    // must not disturb it — it stays plainly unavailable, never "available".
    const states = evaluateOrder(
      [option("listing:1", [[1, 1]]), option("listing:2", [[2, 1]])],
      pools({
        remainingByListingId: new Map([
          [1, 5],
          [2, 0],
        ]),
      }),
      ["listing:1"],
      false,
    );
    expect(states.get("listing:2")).toEqual({ kind: "unavailable" });
  });

  test("a date-needing selection holds nothing until a date is chosen", () => {
    const options = [
      option("package:7", [[1, 1]], { name: "Party Bundle", needsDate: true }),
      option("listing:1", [[1, 1]]),
    ];
    const poolset = pools({ remainingByListingId: new Map([[1, 1]]) });
    const withoutDate = evaluateOrder(options, poolset, ["package:7"], false);
    expect(withoutDate.get("package:7")).toEqual({ kind: "selected" });
    expect(withoutDate.get("listing:1")).toEqual({ kind: "available" });
    const withDate = evaluateOrder(options, poolset, ["package:7"], true);
    expect(withDate.get("listing:1")).toEqual(blockedByParty);
  });
});

describe("evaluateOrder — group pools", () => {
  /** Listings 1 and 2 share capacity group 9, which has one unit left. */
  const oneSharedGroupUnit = () =>
    pools({
      groupIdsByListingId: new Map([
        [1, [9]],
        [2, [9]],
      ]),
      remainingByGroupId: new Map([[9, 1]]),
    });

  test("a package's demand on a shared group pool sums across its members", () => {
    // One package books both members, so its summed demand (2) can never fit.
    const states = evaluateOrder(
      [
        option("package:7", [
          [1, 1],
          [2, 1],
        ]),
      ],
      oneSharedGroupUnit(),
      [],
      false,
    );
    expect(states.get("package:7")).toEqual({ kind: "unavailable" });
  });

  test("group pool contention blocks across different listings", () => {
    const states = evaluateOrder(
      [
        option("listing:1", [[1, 1]], { name: "Morning Slot" }),
        option("listing:2", [[2, 1]], { name: "Afternoon Slot" }),
      ],
      oneSharedGroupUnit(),
      ["listing:1"],
      false,
    );
    expect(states.get("listing:2")).toEqual({
      byKey: "listing:1",
      byName: "Morning Slot",
      kind: "blocked",
    });
  });

  test("a listing in several groups must fit them all", () => {
    const states = evaluateOrder(
      [option("listing:1", [[1, 1]])],
      pools({
        groupIdsByListingId: new Map([[1, [9, 11]]]),
        remainingByGroupId: new Map([
          [9, 5],
          [11, 0],
        ]),
      }),
      [],
      false,
    );
    expect(states.get("listing:1")).toEqual({ kind: "unavailable" });
  });
});
