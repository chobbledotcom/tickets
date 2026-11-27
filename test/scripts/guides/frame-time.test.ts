import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { frameTimeMs } from "#scripts/guides/record/frame-time.ts";

describe("frameTimeMs", () => {
  test("measures from the start and rounds to a whole millisecond", () => {
    expect(frameTimeMs(1000.4, 1000, 0)).toBe(0);
    expect(frameTimeMs(1250.6, 1000, 0)).toBe(251);
  });

  test("holds a frame stamped before the previous one at that time", () => {
    expect(frameTimeMs(1180, 1000, 200)).toBe(200);
  });

  test("keeps a frame stamped at the previous time", () => {
    expect(frameTimeMs(1200, 1000, 200)).toBe(200);
  });

  test("never gives a negative time", () => {
    expect(frameTimeMs(990, 1000, 0)).toBe(0);
  });
});
