import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { coverageDenoJobs, resolveDenoJobs } from "#scripts/workers.ts";

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

describe("coverageDenoJobs", () => {
  test("caps the workers when the caller set none", () => {
    expect(coverageDenoJobs(undefined, 16)).toBe(4);
    expect(coverageDenoJobs(undefined, 8)).toBe(4);
    expect(coverageDenoJobs(undefined, 2)).toBe(2);
  });

  test("leaves an explicit count alone", () => {
    expect(coverageDenoJobs("8", 16)).toBeUndefined();
    expect(coverageDenoJobs("1", 16)).toBeUndefined();
  });
});
