/** Sizes and durations in the words a person reads: pin each ladder's rungs,
 * because the debug page and the admin screens render these directly. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatBytes,
  formatLimitValue,
  formatMs,
  formatSeconds,
} from "#shared/format-units.ts";

describe("format-units", () => {
  test("bytes name the biggest rung they reach, else the bare count", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(999)).toBe("999B");
    expect(formatBytes(1024)).toBe("1KB");
    expect(formatBytes(1048576)).toBe("1MB");
    expect(formatBytes(32 * 1024 * 1024)).toBe("32MB");
  });

  test("milliseconds climb from seconds through minutes to hours", () => {
    expect(formatMs(500)).toBe("500ms");
    expect(formatMs(1000)).toBe("1s");
    expect(formatMs(60 * 1000)).toBe("1min");
    expect(formatMs(60 * 60 * 1000)).toBe("1h");
  });

  test("seconds climb from minutes through hours to days", () => {
    expect(formatSeconds(59)).toBe("59s");
    expect(formatSeconds(60)).toBe("1min");
    expect(formatSeconds(3600)).toBe("1h");
    expect(formatSeconds(24 * 60 * 60)).toBe("1d");
  });

  test("a value rounding onto a rung rounds to a whole rung", () => {
    expect(formatSeconds(90)).toBe("2min");
  });

  test("a limit value reads its unit's ladder, or the plain count", () => {
    expect(formatLimitValue(1024, "bytes")).toBe("1KB");
    expect(formatLimitValue(3600, "seconds")).toBe("1h");
    expect(formatLimitValue(60, "ms")).toBe("60ms");
    expect(formatLimitValue(5, "attempts")).toBe("5 attempts");
  });
});
