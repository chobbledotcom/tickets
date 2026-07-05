import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getUptimeSeconds } from "#shared/uptime.ts";

describe("getUptimeSeconds", () => {
  test("grows by the wall-clock seconds elapsed since the instance started", () => {
    using time = new FakeTime();
    const before = getUptimeSeconds();
    time.tick(3000);
    expect(getUptimeSeconds() - before).toBeCloseTo(3);
  });
});
