import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { openEach } from "#crypto/open-each.ts";

const keyNamed = (name: string): CryptoKey => ({
  algorithm: { name },
  extractable: false,
  type: "private",
  usages: ["decrypt"],
});

const openedWith = openEach(
  async (value: string, key: CryptoKey) => `${value}:${key.algorithm.name}`,
);

describe("openEach", () => {
  test("opens every row with the key it is handed", async () => {
    expect(await openedWith(["a", "b"], keyNamed("k1"))).toEqual([
      "a:k1",
      "b:k1",
    ]);
  });

  test("opens nothing when handed nothing", async () => {
    expect(await openedWith([], keyNamed("k1"))).toEqual([]);
  });

  test("keeps the order it was given", async () => {
    expect(await openedWith(["3", "1", "2"], keyNamed("k"))).toEqual([
      "3:k",
      "1:k",
      "2:k",
    ]);
  });
});
