import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  getAllCacheStats,
  invalidateCachesForTable,
  invalidateCachesForWrite,
  registerCache,
  registerCacheReset,
  registerDependencies,
  registerTableInvalidation,
  resetAllCaches,
  type Unregister,
} from "#shared/cache-registry.ts";

describe("cache-registry", () => {
  // The registry is shared module state (app caches register at load time), so
  // every registration this suite makes is tracked and removed after each test
  // rather than wiping the whole registry out from under the rest of the app.
  const cleanups: Unregister[] = [];
  const track = (unregister: Unregister): void => {
    cleanups.push(unregister);
  };
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** Only the stats this suite registered, by their unique test names. */
  const ownStats = (...names: string[]): { name: string; entries: number }[] =>
    getAllCacheStats()
      .filter((stat) => names.includes(stat.name))
      .map((stat) => ({ entries: stat.entries, name: stat.name }));

  describe("registerCache / getAllCacheStats", () => {
    test("collects a single registered cache's stat", () => {
      track(registerCache(() => ({ entries: 3, name: "registry-widgets" })));
      expect(ownStats("registry-widgets")).toEqual([
        { entries: 3, name: "registry-widgets" },
      ]);
    });

    test("collects every registered cache's stat, in registration order", () => {
      track(registerCache(() => ({ entries: 1, name: "registry-a" })));
      track(registerCache(() => ({ entries: 2, name: "registry-b" })));
      expect(ownStats("registry-a", "registry-b")).toEqual([
        { entries: 1, name: "registry-a" },
        { entries: 2, name: "registry-b" },
      ]);
    });

    test("calls each provider fresh on every call, not a cached snapshot", () => {
      let entries = 1;
      track(registerCache(() => ({ entries, name: "registry-widgets" })));
      expect(ownStats("registry-widgets")).toEqual([
        { entries: 1, name: "registry-widgets" },
      ]);
      entries = 2;
      expect(ownStats("registry-widgets")).toEqual([
        { entries: 2, name: "registry-widgets" },
      ]);
    });

    test("an unregistered provider no longer appears in the stats", () => {
      const unregister = registerCache(() => ({
        entries: 1,
        name: "registry-gone",
      }));
      unregister();
      expect(ownStats("registry-gone")).toEqual([]);
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
      track(
        registerTableInvalidation(["listings"], () => {
          calls++;
        }),
      );
      invalidateCachesForWrite("listings", {
        columns: new Set(),
        verb: "insert",
      });
      expect(calls).toBe(1);
    });

    test("does not fire for a different table", () => {
      let calls = 0;
      track(
        registerTableInvalidation(["listings"], () => {
          calls++;
        }),
      );
      invalidateCachesForWrite("attendees", {
        columns: new Set(),
        verb: "insert",
      });
      expect(calls).toBe(0);
    });

    test("an unregistered invalidator no longer fires", () => {
      let calls = 0;
      const unregister = registerTableInvalidation(
        ["listings", "attendees"],
        () => {
          calls++;
        },
      );
      unregister();
      invalidateCachesForWrite("listings", {
        columns: new Set(),
        verb: "insert",
      });
      invalidateCachesForWrite("attendees", {
        columns: new Set(),
        verb: "insert",
      });
      expect(calls).toBe(0);
    });

    test("registers the same invalidator against every listed table", () => {
      let calls = 0;
      track(
        registerTableInvalidation(["listings", "attendees"], () => {
          calls++;
        }),
      );
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
      track(
        registerTableInvalidation(["listings"], () => {
          firstCalls++;
        }),
      );
      track(
        registerTableInvalidation(["listings"], () => {
          secondCalls++;
        }),
      );
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
        track(
          registerTableInvalidation(
            ["listings"],
            () => {
              calls++;
            },
            { whenColumns },
          ),
        );
        invalidateCachesForWrite("listings", {
          columns: new Set(updatedColumns),
          verb: "update",
        });
        return calls;
      };

      test("an ungated dependency fires on update regardless of assigned columns", () => {
        let calls = 0;
        track(
          registerTableInvalidation(["listings"], () => {
            calls++;
          }),
        );
        invalidateCachesForWrite("listings", {
          columns: new Set(["unrelated_column"]),
          verb: "update",
        });
        expect(calls).toBe(1);
      });

      test("a gated dependency fires on update only when an assigned column is listed", () => {
        expect(callsForGatedUpdate(["price", "name"], ["name"])).toBe(1);
        expect(callsForGatedUpdate(["price", "name"], ["description"])).toBe(0);
      });

      test("an empty whenColumns list gates out every update, since no column can ever match", () => {
        expect(callsForGatedUpdate([], ["name"])).toBe(0);
      });

      for (const verb of ["insert", "delete", "replace"] as const) {
        test(`a gated dependency always fires on ${verb}, regardless of columns`, () => {
          let calls = 0;
          track(
            registerTableInvalidation(
              ["listings"],
              () => {
                calls++;
              },
              { whenColumns: ["price"] },
            ),
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
      track(
        registerTableInvalidation(["listings"], () => {
          calls++;
        }),
      );
      invalidateCachesForTable("listings");
      expect(calls).toBe(1);
    });

    test("fires a column-gated invalidator too, treating the write as unconditional (INSERT semantics)", () => {
      let calls = 0;
      track(
        registerTableInvalidation(
          ["listings"],
          () => {
            calls++;
          },
          { whenColumns: ["price"] },
        ),
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
      track(
        registerDependencies("listings", [], () => {
          calls++;
        }),
      );
      invalidateCachesForWrite("listings", {
        columns: new Set(["unrelated"]),
        verb: "update",
      });
      expect(calls).toBe(1);
    });

    test("registers a plain string dependency unconditionally", () => {
      let calls = 0;
      track(
        registerDependencies("listings", ["listing_attendees"], () => {
          calls++;
        }),
      );
      invalidateCachesForWrite("listing_attendees", {
        columns: new Set(["unrelated"]),
        verb: "update",
      });
      expect(calls).toBe(1);
    });

    test("gates an object dependency's whenColumns on update", () => {
      let calls = 0;
      track(
        registerDependencies(
          "listings",
          [{ table: "listing_prices", whenColumns: ["amount"] }],
          () => {
            calls++;
          },
        ),
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
      track(
        registerDependencies("listings", ["listing_attendees"], () => {
          calls++;
        }),
      );
      invalidateCachesForTable("listings");
      invalidateCachesForTable("listing_attendees");
      expect(calls).toBe(2);
    });

    test("unregistering removes the own-table and every dependency registration", () => {
      let calls = 0;
      const unregister = registerDependencies(
        "listings",
        [
          "listing_attendees",
          { table: "listing_prices", whenColumns: ["amount"] },
        ],
        () => {
          calls++;
        },
      );
      unregister();
      invalidateCachesForTable("listings");
      invalidateCachesForTable("listing_attendees");
      invalidateCachesForWrite("listing_prices", {
        columns: new Set(["amount"]),
        verb: "update",
      });
      expect(calls).toBe(0);
    });
  });

  describe("resetAllCaches", () => {
    test("fires every table-registered invalidator and every reset hook", () => {
      let tableCalls = 0;
      const hookCauses: string[] = [];
      track(
        registerTableInvalidation(["listings"], () => {
          tableCalls++;
        }),
      );
      track(
        registerCacheReset((cause = "manual") => {
          hookCauses.push(cause);
        }),
      );
      resetAllCaches();
      expect(tableCalls).toBe(1);
      expect(hookCauses).toEqual(["write"]);
    });

    test("fires an invalidator registered against several tables only once", () => {
      let calls = 0;
      track(
        registerTableInvalidation(["listings", "listing_attendees"], () => {
          calls++;
        }),
      );
      resetAllCaches();
      expect(calls).toBe(1);
    });

    test("fires a column-gated invalidator too — a full reset ignores gates", () => {
      let calls = 0;
      track(
        registerTableInvalidation(
          ["listings"],
          () => {
            calls++;
          },
          { whenColumns: ["name"] },
        ),
      );
      resetAllCaches();
      expect(calls).toBe(1);
    });

    test("an unregistered reset hook no longer fires", () => {
      let calls = 0;
      const unregister = registerCacheReset(() => {
        calls++;
      });
      unregister();
      resetAllCaches();
      expect(calls).toBe(0);
    });
  });
});
