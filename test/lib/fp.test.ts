import { describe, expect, test } from "bun:test";
import {
  compact,
  filter,
  flatMap,
  groupBy,
  identity,
  isDefined,
  map,
  memoize,
  pick,
  pipe,
  reduce,
  sort,
  sortBy,
  unique,
  uniqueBy,
} from "#fp";

describe("fp", () => {
  describe("pipe", () => {
    test("composes functions left-to-right", () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const result = pipe(addOne, double)(5);
      expect(result).toBe(12); // (5 + 1) * 2
    });

    test("works with single function", () => {
      const addOne = (x: number) => x + 1;
      const result = pipe(addOne)(5);
      expect(result).toBe(6);
    });

    test("works with no functions", () => {
      const result = pipe<number>()(5);
      expect(result).toBe(5);
    });
  });

  describe("filter", () => {
    test("filters array based on predicate", () => {
      const isEven = (x: number) => x % 2 === 0;
      const result = filter(isEven)([1, 2, 3, 4, 5, 6]);
      expect(result).toEqual([2, 4, 6]);
    });

    test("returns empty array when no matches", () => {
      const isNegative = (x: number) => x < 0;
      const result = filter(isNegative)([1, 2, 3]);
      expect(result).toEqual([]);
    });
  });

  describe("map", () => {
    test("transforms array elements", () => {
      const double = (x: number) => x * 2;
      const result = map(double)([1, 2, 3]);
      expect(result).toEqual([2, 4, 6]);
    });

    test("works with empty array", () => {
      const double = (x: number) => x * 2;
      const result = map(double)([]);
      expect(result).toEqual([]);
    });
  });

  describe("flatMap", () => {
    test("maps and flattens results", () => {
      const duplicate = (x: number) => [x, x];
      const result = flatMap(duplicate)([1, 2, 3]);
      expect(result).toEqual([1, 1, 2, 2, 3, 3]);
    });

    test("works with empty array", () => {
      const duplicate = (x: number) => [x, x];
      const result = flatMap(duplicate)([]);
      expect(result).toEqual([]);
    });
  });

  describe("reduce", () => {
    test("reduces array to single value", () => {
      const sum = (acc: number, x: number) => acc + x;
      const result = reduce(sum, 0)([1, 2, 3, 4]);
      expect(result).toBe(10);
    });

    test("works with mutation pattern", () => {
      const collect = (acc: number[], x: number) => {
        acc.push(x * 2);
        return acc;
      };
      const result = reduce(collect, [] as number[])([1, 2, 3]);
      expect(result).toEqual([2, 4, 6]);
    });
  });

  describe("sort", () => {
    test("sorts array non-mutating", () => {
      const original = [3, 1, 2];
      const result = sort((a: number, b: number) => a - b)(original);
      expect(result).toEqual([1, 2, 3]);
      expect(original).toEqual([3, 1, 2]); // Original unchanged
    });

    test("sorts descending", () => {
      const result = sort((a: number, b: number) => b - a)([1, 3, 2]);
      expect(result).toEqual([3, 2, 1]);
    });
  });

  describe("sortBy", () => {
    test("sorts by property key", () => {
      const items = [{ name: "c" }, { name: "a" }, { name: "b" }];
      const result = sortBy<{ name: string }>("name")(items);
      expect(result).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
    });

    test("sorts by getter function", () => {
      const items = [{ value: 3 }, { value: 1 }, { value: 2 }];
      const result = sortBy((x: { value: number }) => x.value)(items);
      expect(result).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    });

    test("does not mutate original", () => {
      const original = [{ n: 2 }, { n: 1 }];
      sortBy<{ n: number }>("n")(original);
      expect(original).toEqual([{ n: 2 }, { n: 1 }]);
    });
  });

  describe("unique", () => {
    test("removes duplicate primitives", () => {
      const result = unique([1, 2, 2, 3, 3, 3]);
      expect(result).toEqual([1, 2, 3]);
    });

    test("works with strings", () => {
      const result = unique(["a", "b", "a", "c"]);
      expect(result).toEqual(["a", "b", "c"]);
    });

    test("handles empty array", () => {
      const result = unique([]);
      expect(result).toEqual([]);
    });
  });

  describe("uniqueBy", () => {
    test("removes duplicates by key function", () => {
      const items = [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
        { id: 1, name: "c" },
      ];
      const result = uniqueBy((x: { id: number; name: string }) => x.id)(items);
      expect(result).toEqual([
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ]);
    });

    test("handles empty array", () => {
      const result = uniqueBy((x: number) => x)([]);
      expect(result).toEqual([]);
    });
  });

  describe("compact", () => {
    test("removes falsy values", () => {
      const result = compact([1, null, 2, undefined, 3, false, 0, "", 4]);
      expect(result).toEqual([1, 2, 3, 4]);
    });

    test("handles empty array", () => {
      const result = compact([]);
      expect(result).toEqual([]);
    });

    test("handles all falsy values", () => {
      const result = compact([null, undefined, false, 0, ""]);
      expect(result).toEqual([]);
    });
  });

  describe("groupBy", () => {
    test("groups items by key function", () => {
      const items = [
        { type: "a", value: 1 },
        { type: "b", value: 2 },
        { type: "a", value: 3 },
      ];
      const result = groupBy((x: { type: string; value: number }) => x.type)(
        items,
      );
      expect(result).toEqual({
        a: [
          { type: "a", value: 1 },
          { type: "a", value: 3 },
        ],
        b: [{ type: "b", value: 2 }],
      });
    });

    test("handles empty array", () => {
      const result = groupBy((x: { type: string }) => x.type)([]);
      expect(result).toEqual({});
    });
  });

  describe("memoize", () => {
    test("caches function results", () => {
      let callCount = 0;
      const expensive = (x: number) => {
        callCount++;
        return x * 2;
      };
      const memoized = memoize(expensive);

      expect(memoized(5)).toBe(10);
      expect(memoized(5)).toBe(10);
      expect(callCount).toBe(1); // Only called once

      expect(memoized(3)).toBe(6);
      expect(callCount).toBe(2);
    });

    test("handles multiple arguments", () => {
      const add = (a: number, b: number) => a + b;
      const memoized = memoize(add);

      expect(memoized(1, 2)).toBe(3);
      expect(memoized(1, 2)).toBe(3);
      expect(memoized(2, 1)).toBe(3);
    });
  });

  describe("pick", () => {
    test("picks specified keys from object", () => {
      const obj = { a: 1, b: 2, c: 3 };
      const result = pick<typeof obj, "a" | "c">(["a", "c"])(obj);
      expect(result).toEqual({ a: 1, c: 3 });
    });

    test("ignores missing keys", () => {
      const obj = { a: 1, b: 2 };
      const result = pick<typeof obj, "a">(["a"])(obj);
      expect(result).toEqual({ a: 1 });
    });
  });

  describe("isDefined", () => {
    test("returns true for defined values", () => {
      expect(isDefined(0)).toBe(true);
      expect(isDefined("")).toBe(true);
      expect(isDefined(false)).toBe(true);
      expect(isDefined([])).toBe(true);
    });

    test("returns false for null and undefined", () => {
      expect(isDefined(null)).toBe(false);
      expect(isDefined(undefined)).toBe(false);
    });
  });

  describe("identity", () => {
    test("returns the same value", () => {
      expect(identity(5)).toBe(5);
      expect(identity("hello")).toBe("hello");
      const obj = { a: 1 };
      expect(identity(obj)).toBe(obj);
    });
  });

  describe("composition", () => {
    test("works with pipe and curried functions", () => {
      const numbers = [1, 2, 3, 4, 5, 6];
      const result = pipe(
        filter((x: number) => x % 2 === 0),
        map((x: number) => x * 2),
      )(numbers);
      expect(result).toEqual([4, 8, 12]);
    });
  });
});
