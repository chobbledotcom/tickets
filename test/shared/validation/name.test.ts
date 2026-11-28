import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { checkedName } from "#shared/validation/name.ts";

const limits = { error: "tooLong", length: 4 };

describe("the name check", () => {
  test("trims and accepts a name within the limit", () => {
    expect(checkedName(" Jane ", "empty", limits)).toEqual({
      ok: true,
      value: "Jane",
    });
  });

  test("refuses a blank name", () => {
    expect(checkedName(" ", "empty", limits)).toEqual({
      error: "empty",
      ok: false,
    });
  });

  test("refuses a name over the limit", () => {
    expect(checkedName("Janet", "empty", limits)).toEqual({
      error: "tooLong",
      ok: false,
    });
  });
});
