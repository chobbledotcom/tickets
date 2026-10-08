import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  coverageDenoJobs,
  precommitDenoJobs,
  resolveDenoJobs,
} from "#scripts/workers.ts";

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

  test("caps the workers for blank and invalid values", () => {
    expect(coverageDenoJobs("", 16)).toBe(4);
    expect(coverageDenoJobs("0", 16)).toBe(4);
    expect(coverageDenoJobs("abc", 16)).toBe(4);
  });

  test("leaves a valid explicit count alone", () => {
    expect(coverageDenoJobs("8", 16)).toBeUndefined();
    expect(coverageDenoJobs("1", 16)).toBeUndefined();
  });
});

describe("precommitDenoJobs", () => {
  test("caps the default, because the run's test step is the coverage gate", () => {
    expect(precommitDenoJobs(16, false, undefined)).toBe(4);
    expect(precommitDenoJobs(16, true, undefined)).toBe(4);
  });

  test("keeps the small-machine floor under the cap", () => {
    expect(precommitDenoJobs(2, false, undefined)).toBe(1);
    expect(precommitDenoJobs(1, false, undefined)).toBe(1);
  });

  test("a valid explicit count wins", () => {
    expect(precommitDenoJobs(16, false, "8")).toBe(8);
    expect(precommitDenoJobs(16, true, "1")).toBe(1);
  });

  test("an invalid count falls back to the capped default", () => {
    expect(precommitDenoJobs(16, false, "abc")).toBe(4);
    expect(precommitDenoJobs(16, false, "0")).toBe(4);
    expect(precommitDenoJobs(16, false, "")).toBe(4);
  });
});
