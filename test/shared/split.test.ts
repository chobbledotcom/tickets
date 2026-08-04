import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { commaParts, nonBlankLines } from "#shared/split.ts";

describe("commaParts", () => {
  test("trims parts and drops empty ones", () => {
    expect(commaParts("a, b ,,  , c")).toEqual(["a", "b", "c"]);
  });
  test("returns an empty array for a blank string", () => {
    expect(commaParts("   ")).toEqual([]);
  });
  test("keeps a single part", () => {
    expect(commaParts("Monday")).toEqual(["Monday"]);
  });
});

describe("nonBlankLines", () => {
  test("splits on newlines, dropping blank lines", () => {
    expect(nonBlankLines("first\n  \r\n second \nthird")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
