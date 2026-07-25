import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseWorkerCount, precommitWorkerCount } from "#scripts/workers.ts";

describe("parseWorkerCount", () => {
  test("returns the parsed value for a positive integer string", () => {
    expect(parseWorkerCount("4", 8)).toBe(4);
  });

  test("falls back when the value is not a positive integer", () => {
    expect(parseWorkerCount(undefined, 8)).toBe(8);
    expect(parseWorkerCount("", 8)).toBe(8);
    expect(parseWorkerCount("0", 8)).toBe(8);
    expect(parseWorkerCount("-1", 8)).toBe(8);
    expect(parseWorkerCount("2.5", 8)).toBe(8);
    expect(parseWorkerCount("not-a-number", 8)).toBe(8);
  });
});

describe("precommitWorkerCount", () => {
  test("uses every thread in CI", () => {
    expect(precommitWorkerCount(16, true)).toBe(16);
    expect(precommitWorkerCount(1, true)).toBe(1);
  });

  test("uses half the threads minus one locally", () => {
    expect(precommitWorkerCount(16, false)).toBe(7);
    expect(precommitWorkerCount(8, false)).toBe(3);
  });

  test("never drops below one locally", () => {
    expect(precommitWorkerCount(4, false)).toBe(1);
    expect(precommitWorkerCount(2, false)).toBe(1);
    expect(precommitWorkerCount(1, false)).toBe(1);
  });
});
