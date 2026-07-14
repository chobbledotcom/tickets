import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  byId,
  filter,
  flatMap,
  groupToMap,
  map,
  mapBy,
  mapById,
  partition,
  pipe,
  sumByKey,
} from "#fp";

describe("fp collections", () => {
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
  });

  describe("byId", () => {
    test("indexes items by id", () => {
      const first = { id: 1, name: "a" };
      const second = { id: 2, name: "b" };
      const indexed = byId([first, second]);
      expect(indexed.get(1)).toBe(first);
      expect(indexed.get(2)).toBe(second);
      expect(indexed.size).toBe(2);
    });

    test("later items with the same id win", () => {
      const first = { id: 1, name: "first" };
      const second = { id: 1, name: "second" };
      expect(byId([first, second]).get(1)).toBe(second);
    });

    test("empty input gives an empty map", () => {
      expect(byId([])).toEqual(new Map());
    });
  });

  describe("mapBy", () => {
    const namesByCode = mapBy(
      "code",
      (item: { code: string; name: string }) => item.name,
    );

    test("indexes chosen values by chosen keys", () => {
      expect(
        namesByCode([
          { code: "a", name: "First" },
          { code: "b", name: "Second" },
        ]),
      ).toEqual(
        new Map([
          ["a", "First"],
          ["b", "Second"],
        ]),
      );
    });

    test("later items with the same key win", () => {
      expect(
        namesByCode([
          { code: "a", name: "First" },
          { code: "a", name: "Last" },
        ]),
      ).toEqual(new Map([["a", "Last"]]));
    });
  });

  describe("mapById", () => {
    const toName = mapById((item: { id: number; name: string }) => item.name);

    test("indexes each id to the chosen value", () => {
      const indexed = toName([
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ]);
      expect(indexed.get(1)).toBe("a");
      expect(indexed.get(2)).toBe("b");
      expect(indexed.size).toBe(2);
    });

    test("later items with the same id win", () => {
      expect(
        toName([
          { id: 1, name: "first" },
          { id: 1, name: "second" },
        ]).get(1),
      ).toBe("second");
    });

    test("empty input gives an empty map", () => {
      expect(toName([])).toEqual(new Map());
    });
  });
});
