import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  compact,
  filter,
  firstProblem,
  flatMap,
  groupToMap,
  identity,
  joinStrings,
  map,
  mapBy,
  partition,
  pipe,
  requiredMapValue,
  sumByKey,
} from "#fp";

describe("fp collections", () => {
  describe("compact", () => {
    test("removes null and undefined while keeping other falsy values", () => {
      expect(compact([0, null, "", undefined, false])).toEqual([0, "", false]);
    });
  });

  describe("joinStrings", () => {
    test("joins every string without adding text", () => {
      expect(joinStrings(["first", "", "second"])).toBe("firstsecond");
    });
  });

  describe("requiredMapValue", () => {
    test("returns a stored value", () => {
      expect(requiredMapValue(new Map([[4, "four"]]), 4, "missing")).toBe(
        "four",
      );
    });

    test("throws the supplied error when the key is missing", () => {
      expect(() => requiredMapValue(new Map(), 4, "Number 4 missing")).toThrow(
        "Number 4 missing",
      );
    });
  });

  describe("partition", () => {
    test("splits into matching and remaining items in order", () => {
      const [evens, odds] = partition((number: number) => number % 2 === 0)([
        1, 2, 3, 4, 5,
      ]);
      expect(evens).toEqual([2, 4]);
      expect(odds).toEqual([1, 3, 5]);
    });

    test("all-match and none-match put every item on one side", () => {
      expect(partition((number: number) => number > 0)([1, 2])).toEqual([
        [1, 2],
        [],
      ]);
      expect(partition((number: number) => number > 9)([1, 2])).toEqual([
        [],
        [1, 2],
      ]);
    });
  });

  describe("firstProblem", () => {
    test("stops after the first reported problem", async () => {
      const checked: number[] = [];
      const problem = await firstProblem(async (value: number) => {
        checked.push(value);
        return value === 2 ? "Two is blocked" : null;
      })([1, 2, 3]);
      expect(problem).toBe("Two is blocked");
      expect(checked).toEqual([1, 2]);
    });

    test("returns null when every item passes", async () => {
      expect(await firstProblem(() => null)([1, 2])).toBeNull();
    });
  });

  describe("pipe", () => {
    interface Item {
      active: boolean;
      id: number;
    }

    test("threads callback types across two to four stages", () => {
      const items: Item[] = [
        { active: true, id: 1 },
        { active: false, id: 2 },
        { active: true, id: 3 },
      ];
      const ids = pipe(
        filter((item: Item) => item.active),
        map((item) => item.id),
      )(items);
      const idsTypeCheck: number[] = ids;
      const bigIds = pipe(
        filter((item: Item) => item.active),
        map((item) => item.id),
        filter((id) => id > 0),
      )(items);
      const bigIdsTypeCheck: number[] = bigIds;
      const labels = pipe(
        filter((item: Item) => item.active),
        map((item) => item.id),
        filter((id) => id > 0),
        map((id) => `id-${id}`),
      )(items);
      const labelsTypeCheck: string[] = labels;

      expect(ids).toEqual([1, 3]);
      expect(bigIds).toEqual([1, 3]);
      expect(labels).toEqual(["id-1", "id-3"]);
      void idsTypeCheck;
      void bigIdsTypeCheck;
      void labelsTypeCheck;
    });

    test("flatMap callback infers its parameter mid-pipe", () => {
      const items: Item[] = [{ active: true, id: 1 }];
      const expanded = pipe(
        filter((item: Item) => item.active),
        flatMap((item) => [item.id, item.id + 1]),
      )(items);
      const typeCheck: number[] = expanded;
      expect(expanded).toEqual([1, 2]);
      void typeCheck;
    });

    test("identity overload returns input unchanged", () => {
      const identity = pipe<number>();
      const result: number = identity(42);
      expect(result).toBe(42);
    });

    test("rejects a mismatched chain at compile time", () => {
      const make = () =>
        pipe(
          // @ts-expect-error number[] is not assignable to string[]
          map((value: string) => value.length),
          map((value: string) => value.toUpperCase()),
        );
      void make;
    });
  });

  describe("groupToMap", () => {
    test("groups rows by key and keeps each chosen value", () => {
      const rows = [
        { listing: 20, question: 1 },
        { listing: 30, question: 2 },
        { listing: 10, question: 1 },
      ];
      const listingsByQuestion = groupToMap(
        (row: { question: number; listing: number }) => row.question,
        (row) => row.listing,
      )(rows);
      expect(listingsByQuestion).toEqual(
        new Map([
          [1, [20, 10]],
          [2, [30]],
        ]),
      );
    });

    test("keeps first-occurrence key order and handles no rows", () => {
      const rows = [
        { key: "b", value: 1 },
        { key: "a", value: 2 },
        { key: "b", value: 3 },
      ];
      const grouped = groupToMap(
        (row: { key: string; value: number }) => row.key,
        (row) => row.value,
      );
      expect([...grouped(rows).keys()]).toEqual(["b", "a"]);
      expect(grouped([])).toEqual(new Map());
    });
  });

  describe("sumByKey", () => {
    test("sums repeated keys", () => {
      const totals = sumByKey(
        (item: { id: number; amount: number }) => item.id,
        (item) => item.amount,
      )([
        { amount: 10, id: 1 },
        { amount: 5, id: 2 },
        { amount: 3, id: 1 },
      ]);
      expect(totals).toEqual(
        new Map([
          [1, 13],
          [2, 5],
        ]),
      );
    });

    test("sums signed amounts and handles no items", () => {
      const signed = sumByKey(
        (item: { key: string; value: number }) => item.key,
        (item) => item.value,
      )([
        { key: "a", value: 4 },
        { key: "a", value: -6 },
      ]);
      expect(signed.get("a")).toBe(-2);
      expect(
        sumByKey(
          (item: { key: string }) => item.key,
          () => 1,
        )([]),
      ).toEqual(new Map());
    });

    test("keeps a NaN total", () => {
      const totals = sumByKey(
        (item: { amount: number; key: string }) => item.key,
        (item) => item.amount,
      )([
        { amount: Number.NaN, key: "a" },
        { amount: 2, key: "a" },
      ]);
      expect(totals.get("a")).toBe(Number.NaN);
    });
  });

  describe("mapBy", () => {
    type Item = { code: string; id: number; name: string };

    const namesByCode = mapBy("code", (item: Item) => item.name);
    const itemsById = mapBy("id", identity<Item>);

    test("indexes chosen values by chosen keys", () => {
      expect(
        namesByCode([
          { code: "a", id: 1, name: "First" },
          { code: "b", id: 2, name: "Second" },
        ]),
      ).toEqual(
        new Map([
          ["a", "First"],
          ["b", "Second"],
        ]),
      );
    });

    test("indexes whole items by id", () => {
      const first: Item = { code: "a", id: 1, name: "First" };
      const second: Item = { code: "b", id: 2, name: "Second" };
      const indexed = itemsById([first, second]);
      expect(indexed.get(1)).toBe(first);
      expect(indexed.get(2)).toBe(second);
      expect(indexed.size).toBe(2);
    });

    test("keeps first key order while later duplicate values win", () => {
      expect(
        namesByCode([
          { code: "b", id: 1, name: "First B" },
          { code: "a", id: 2, name: "A" },
          { code: "b", id: 3, name: "Last B" },
        ]),
      ).toEqual(
        new Map([
          ["b", "Last B"],
          ["a", "A"],
        ]),
      );
    });

    test("empty input gives an empty map", () => {
      expect(itemsById([])).toEqual(new Map());
    });
  });
});
