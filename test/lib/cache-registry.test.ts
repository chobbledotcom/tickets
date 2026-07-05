import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  getAllCacheStats,
  invalidateCachesForTable,
  invalidateCachesForWrite,
  registerCache,
  registerDependencies,
  registerTableInvalidation,
  resetCacheRegistry,
} from "#shared/cache-registry.ts";

describe("cache-registry", () => {
  afterEach(() => resetCacheRegistry());

  describe("registerCache / getAllCacheStats", () => {
    test("returns an empty array when no caches are registered", () => {
      expect(getAllCacheStats()).toEqual([]);
    });

    test("collects a single registered cache's stat", () => {
      registerCache(() => ({ entries: 3, name: "widgets" }));
      expect(getAllCacheStats()).toEqual([{ entries: 3, name: "widgets" }]);
    });

    test("collects every registered cache's stat, in registration order", () => {
      registerCache(() => ({ entries: 1, name: "a" }));
      registerCache(() => ({ entries: 2, name: "b" }));
      expect(getAllCacheStats()).toEqual([
        { entries: 1, name: "a" },
        { entries: 2, name: "b" },
      ]);
    });

    test("calls each provider fresh on every call, not a cached snapshot", () => {
      let entries = 1;
      registerCache(() => ({ entries, name: "widgets" }));
      expect(getAllCacheStats()).toEqual([{ entries: 1, name: "widgets" }]);
      entries = 2;
      expect(getAllCacheStats()).toEqual([{ entries: 2, name: "widgets" }]);
    });
  });

  describe("registerTableInvalidation / invalidateCachesForWrite", () => {
    test("does not fire for a table with no registrations", () => {
      expect(() =>
        invalidateCachesForWrite("untouched", {
          columns: new Set(),
          verb: "insert",
        }),
      ).not.toThrow();
    });

    test("fires the invalidator when its exact table is written", () => {
      let calls = 0;
      registerTableInvalidation(["listings"], () => {
        calls++;
      });
      invalidateCachesForWrite("listings", {
        columns: new Set(),
        verb: "insert",
      });
      expect(calls).toBe(1);
    });

    test("does not fire for a different table", () => {
      let calls = 0;
      registerTableInvalidation(["listings"], () => {
        calls++;
      });
      invalidateCachesForWrite("attendees", {
        columns: new Set(),
        verb: "insert",
      });
      expect(calls).toBe(0);
    });

    test("registers the same invalidator against every listed table", () => {
      let calls = 0;
      registerTableInvalidation(["listings", "attendees"], () => {
        calls++;
      });
      invalidateCachesForWrite("listings", {
        columns: new Set(),
        verb: "insert",
      });
      invalidateCachesForWrite("attendees", {
        columns: new Set(),
        verb: "insert",
      });
      expect(calls).toBe(2);
    });

    test("fires every independently-registered invalidator for the same table", () => {
      let firstCalls = 0;
      let secondCalls = 0;
      registerTableInvalidation(["listings"], () => {
        firstCalls++;
      });
      registerTableInvalidation(["listings"], () => {
        secondCalls++;
      });
      invalidateCachesForWrite("listings", {
        columns: new Set(),
        verb: "insert",
      });
      expect(firstCalls).toBe(1);
      expect(secondCalls).toBe(1);
    });

    describe("whenColumns gating", () => {
      /** Registers a gated invalidator on "listings" and returns how many
       * times it fired for a single update touching `updatedColumns`. */
      const callsForGatedUpdate = (
        whenColumns: readonly string[],
        updatedColumns: readonly string[],
      ): number => {
        let calls = 0;
        registerTableInvalidation(
          ["listings"],
          () => {
            calls++;
          },
          { whenColumns },
        );
        invalidateCachesForWrite("listings", {
          columns: new Set(updatedColumns),
          verb: "update",
        });
        return calls;
      };

      test("an ungated dependency fires on update regardless of assigned columns", () => {
        let calls = 0;
        registerTableInvalidation(["listings"], () => {
          calls++;
        });
        invalidateCachesForWrite("listings", {
          columns: new Set(["unrelated_column"]),
          verb: "update",
        });
        expect(calls).toBe(1);
      });

      test("a gated dependency fires on update only when an assigned column is listed", () => {
        expect(callsForGatedUpdate(["price", "name"], ["name"])).toBe(1);
        expect(callsForGatedUpdate(["price", "name"], ["description"])).toBe(
          0,
        );
      });

      test("an empty whenColumns list gates out every update, since no column can ever match", () => {
        expect(callsForGatedUpdate([], ["name"])).toBe(0);
      });

      for (const verb of ["insert", "delete", "replace"] as const) {
        test(`a gated dependency always fires on ${verb}, regardless of columns`, () => {
          let calls = 0;
          registerTableInvalidation(
            ["listings"],
            () => {
              calls++;
            },
            { whenColumns: ["price"] },
          );
          invalidateCachesForWrite("listings", { columns: new Set(), verb });
          expect(calls).toBe(1);
        });
      }
    });
  });

  describe("invalidateCachesForTable", () => {
    test("fires an ungated invalidator", () => {
      let calls = 0;
      registerTableInvalidation(["listings"], () => {
        calls++;
      });
      invalidateCachesForTable("listings");
      expect(calls).toBe(1);
    });

    test("fires a column-gated invalidator too, treating the write as unconditional (INSERT semantics)", () => {
      let calls = 0;
      registerTableInvalidation(
        ["listings"],
        () => {
          calls++;
        },
        { whenColumns: ["price"] },
      );
      invalidateCachesForTable("listings");
      expect(calls).toBe(1);
    });

    test("is a no-op for a table with no registrations", () => {
      expect(() => invalidateCachesForTable("untouched")).not.toThrow();
    });
  });

  describe("registerDependencies", () => {
    test("registers the own table unconditionally, even for an update touching unrelated columns", () => {
      let calls = 0;
      registerDependencies("listings", [], () => {
        calls++;
      });
      invalidateCachesForWrite("listings", {
        columns: new Set(["unrelated"]),
        verb: "update",
      });
      expect(calls).toBe(1);
    });

    test("registers a plain string dependency unconditionally", () => {
      let calls = 0;
      registerDependencies("listings", ["listing_attendees"], () => {
        calls++;
      });
      invalidateCachesForWrite("listing_attendees", {
        columns: new Set(["unrelated"]),
        verb: "update",
      });
      expect(calls).toBe(1);
    });

    test("gates an object dependency's whenColumns on update", () => {
      let calls = 0;
      registerDependencies(
        "listings",
        [{ table: "listing_prices", whenColumns: ["amount"] }],
        () => {
          calls++;
        },
      );
      invalidateCachesForWrite("listing_prices", {
        columns: new Set(["unrelated"]),
        verb: "update",
      });
      expect(calls).toBe(0);

      invalidateCachesForWrite("listing_prices", {
        columns: new Set(["amount"]),
        verb: "update",
      });
      expect(calls).toBe(1);
    });

    test("fires once per independently-written table, not once overall", () => {
      let calls = 0;
      registerDependencies("listings", ["listing_attendees"], () => {
        calls++;
      });
      invalidateCachesForTable("listings");
      invalidateCachesForTable("listing_attendees");
      expect(calls).toBe(2);
    });
  });

  describe("resetCacheRegistry", () => {
    test("clears registered cache-stat providers", () => {
      registerCache(() => ({ entries: 1, name: "widgets" }));
      resetCacheRegistry();
      expect(getAllCacheStats()).toEqual([]);
    });

    test("clears registered table invalidators", () => {
      let calls = 0;
      registerTableInvalidation(["listings"], () => {
        calls++;
      });
      resetCacheRegistry();
      invalidateCachesForWrite("listings", {
        columns: new Set(),
        verb: "insert",
      });
      expect(calls).toBe(0);
    });
  });
});
