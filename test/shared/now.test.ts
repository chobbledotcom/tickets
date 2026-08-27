import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  expiresIn,
  isoBefore,
  nowIso,
  nowSeconds,
  parseDateMs,
} from "#shared/now.ts";

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

describe("parseDateMs", () => {
  test("a parsable timestamp reads back as its epoch milliseconds", () => {
    expect(parseDateMs("2026-07-01T00:00:00.000Z")).toBe(1782864000000);
  });

  test("a date with no time reads back as midnight UTC", () => {
    expect(parseDateMs("2026-07-01")).toBe(1782864000000);
  });

  test("an unparsable value reads back as nothing, not as a broken number", () => {
    expect(parseDateMs("not a date")).toBeNull();
  });
});
