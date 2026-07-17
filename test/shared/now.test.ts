import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { expiresIn, isoBefore, nowIso, nowSeconds } from "#shared/now.ts";

describe("expiresIn", () => {
  test("adds the max age to the current epoch seconds", () => {
    using _time = new FakeTime(1_700_000_000_000);
    expect(nowSeconds()).toBe(1_700_000_000);
    expect(expiresIn(300)).toBe(1_700_000_300);
    expect(expiresIn(0)).toBe(1_700_000_000);
  });

  test("a longer max age yields a later expiry", () => {
    using _time = new FakeTime(1_700_000_000_000);
    expect(expiresIn(90 * 24 * 60 * 60)).toBe(1_700_000_000 + 7_776_000);
  });
});

describe("nowIso", () => {
  test("returns the current instant as an ISO-8601 string", () => {
    using _time = new FakeTime(1_700_000_000_000);
    expect(nowIso()).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("isoBefore", () => {
  test("returns an ISO instant the given duration before now", () => {
    using _time = new FakeTime(1_700_000_000_000);
    expect(isoBefore(60_000)).toBe("2023-11-14T22:12:20.000Z");
  });
});
