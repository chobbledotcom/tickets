import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resolveDenoJobs } from "#scripts/workers.ts";

describe("resolveDenoJobs", () => {
  test("keeps a valid DENO_JOBS value", () => {
    expect(resolveDenoJobs(16, false, "4")).toBe(4);
    expect(resolveDenoJobs(16, true, "1")).toBe(1);
  });

  test("replaces invalid DENO_JOBS values with the capped count", () => {
    for (const value of [
      "",
      "0",
      "-1",
      "2.5",
      "1e2",
      "0x10",
      " 4 ",
      "not-a-number",
    ]) {
      expect(resolveDenoJobs(16, false, value)).toBe(7);
    }
  });

  test("returns the CI worker count when unset in CI", () => {
    expect(resolveDenoJobs(16, true, undefined)).toBe(16);
    expect(resolveDenoJobs(1, true, undefined)).toBe(1);
  });

  test("returns the capped local count when unset locally", () => {
    expect(resolveDenoJobs(16, false, undefined)).toBe(7);
    expect(resolveDenoJobs(8, false, undefined)).toBe(3);
    expect(resolveDenoJobs(4, false, undefined)).toBe(1);
    expect(resolveDenoJobs(2, false, undefined)).toBe(1);
    expect(resolveDenoJobs(1, false, undefined)).toBe(1);
  });
});
