import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { frameTimeMs } from "#scripts/guides/record/frame-time.ts";

describe("frameTimeMs", () => {
  test("rounds from the start and never goes before the previous frame", () => {
    const times = [
      frameTimeMs(1000.4, 1000, 0),
      frameTimeMs(1250.6, 1000, 0),
      frameTimeMs(1180, 1000, 200),
      frameTimeMs(1200, 1000, 200),
      frameTimeMs(990, 1000, 0),
    ];
    expect(times).toEqual([0, 251, 200, 200, 0]);
  });
});
