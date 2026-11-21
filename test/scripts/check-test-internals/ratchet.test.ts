import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ratchetFindings } from "#scripts/check-test-internals/ratchet.ts";

describe("ratchetFindings", () => {
  test("compares nothing when the base holds no registry", () => {
    expect(ratchetFindings(undefined, { "test/a.ts": 9 })).toEqual([]);
  });

  test("passes a registry that equals the base", () => {
    expect(ratchetFindings({ "test/a.ts": 2 }, { "test/a.ts": 2 })).toEqual([]);
  });

  test("passes a registry that falls or drops a file", () => {
    expect(
      ratchetFindings({ "test/a.ts": 2, "test/b.ts": 1 }, { "test/a.ts": 1 }),
    ).toEqual([]);
  });

  test("fails a file that rises above the base", () => {
    expect(ratchetFindings({ "test/a.ts": 2 }, { "test/a.ts": 3 })).toEqual([
      "test/a.ts [risen]: holds 3 counted imports, more than the 2 on the merge base — remove the imports that the branch added",
    ]);
  });

  test("fails a new file that nothing pays for", () => {
    expect(
      ratchetFindings({ "test/a.ts": 2 }, { "test/a.ts": 2, "test/new.ts": 1 }),
    ).toEqual([
      "test/new.ts [unfunded]: is a new file with 1 counted imports, and the branch frees 0 for 1 new — drive the app through the driver, or free the same count in other files",
    ]);
  });

  test("passes a split whose new files fit inside the count that the branch frees", () => {
    expect(
      ratchetFindings(
        { "test/big.ts": 4 },
        { "test/one.ts": 2, "test/two.ts": 2 },
      ),
    ).toEqual([]);
  });

  test("passes a new file paid for by a fall in another file", () => {
    expect(
      ratchetFindings({ "test/a.ts": 3 }, { "test/a.ts": 1, "test/new.ts": 2 }),
    ).toEqual([]);
  });

  test("fails every new file when the new counts exceed the freed count, in sorted order", () => {
    const found = ratchetFindings(
      { "test/a.ts": 1 },
      { "test/y.ts": 1, "test/z.ts": 1 },
    );
    expect(found.map((line) => line.split(" ")[0])).toEqual([
      "test/y.ts",
      "test/z.ts",
    ]);
  });
});
