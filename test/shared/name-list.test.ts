import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { nameList } from "#shared/name-list.ts";

describe("nameList", () => {
  test("one name stands alone", () => {
    expect(nameList(["Hall"])).toBe("Hall");
  });

  test("two names join with 'and'", () => {
    expect(nameList(["Hall", "Boat"])).toBe("Hall and Boat");
  });

  test("three names read as a sentence list", () => {
    expect(nameList(["Hall", "Boat", "Marquee"])).toBe(
      "Hall, Boat, and Marquee",
    );
  });

  test("no names gives an empty phrase", () => {
    expect(nameList([])).toBe("");
  });
});
