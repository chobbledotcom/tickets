import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { matchKey, pairKey } from "#shared/keys.ts";

describe("matchKey", () => {
  test("drops surrounding spaces and letter case", () => {
    expect(matchKey("  Weekend Pass  ")).toBe("weekend pass");
    expect(matchKey("WEEKEND pass")).toBe("weekend pass");
  });
});

describe("pairKey", () => {
  test("joins two ids with a colon", () => {
    expect(pairKey(3, 7)).toBe("3:7");
  });

  test("order matters — first then second", () => {
    expect(pairKey(7, 3)).toBe("7:3");
    expect(pairKey(7, 3)).not.toBe(pairKey(3, 7));
  });
});
