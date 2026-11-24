import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { occurrencesIn } from "#fp-strings";
import { idSet, refusalOf, withoutKey } from "#shared/fp-records.ts";

describe("withoutKey", () => {
  test("copies the record with the one key left out", () => {
    const row = { id: 3, name: "Gig", slug_index: "x" };
    expect(withoutKey("slug_index")(row)).toEqual({ id: 3, name: "Gig" });
    expect(row).toEqual({ id: 3, name: "Gig", slug_index: "x" });
  });
});

describe("refusalOf", () => {
  test("throws its message every time it is called", () => {
    const refuse = refusalOf("Read the whole site.");
    expect(refuse).toThrow(new Error("Read the whole site."));
    expect(refuse).toThrow(new Error("Read the whole site."));
  });
});

describe("occurrencesIn", () => {
  const named = occurrencesIn("b-a-c-a", (item: string) => item);

  test("orders the found items by the place of their first occurrence", () => {
    expect(named(["c", "a", "b"])).toEqual([
      { at: 0, item: "b" },
      { at: 2, item: "a" },
      { at: 4, item: "c" },
    ]);
  });

  test("leaves out an item whose mark does not occur", () => {
    expect(named(["z", "a"])).toEqual([{ at: 2, item: "a" }]);
  });

  test("finds a mark at the very start", () => {
    expect(named(["b"])).toEqual([{ at: 0, item: "b" }]);
  });

  test("searches from the given place", () => {
    expect(
      occurrencesIn("b-a-c-a", (item: string) => item, 3)(["a", "b"]),
    ).toEqual([{ at: 6, item: "a" }]);
  });
});

describe("idSet", () => {
  test("holds each item's id once", () => {
    const rows = [{ id: 7 }, { id: 2 }, { id: 7 }];
    expect([...idSet(rows)]).toEqual([7, 2]);
  });

  test("reads ids from any iterable", () => {
    const rows = new Map([["a", { id: "x" }]]).values();
    expect([...idSet(rows)]).toEqual(["x"]);
  });
});
