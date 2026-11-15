import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  coverageDenoJobs,
  precommitDenoJobs,
  resolveDenoJobs,
} from "#scripts/workers.ts";

/** The `DENO_JOBS` values that no worker count accepts. */
const INVALID_DENO_JOBS = [
  "",
  "0",
  "-1",
  "2.5",
  "1e2",
  "0x10",
  " 4 ",
  "not-a-number",
];

describe("resolveDenoJobs", () => {
  test("keeps a valid DENO_JOBS value", () => {
    for (const [threads, ci, jobs, expected] of [
      [16, false, "4", 4],
      [16, true, "1", 1],
    ] as const) {
      expect(resolveDenoJobs(threads, ci, jobs)).toBe(expected);
    }
  });

  test("replaces invalid DENO_JOBS values with the capped count", () => {
    for (const jobs of INVALID_DENO_JOBS) {
      expect(resolveDenoJobs(16, false, jobs)).toBe(7);
    }
  });

  test("returns the CI worker count when unset in CI", () => {
    for (const threads of [16, 1]) {
      expect(resolveDenoJobs(threads, true, undefined)).toBe(threads);
    }
  });

  test("returns the capped local count when unset locally", () => {
    for (const [threads, expected] of [
      [16, 7],
      [8, 3],
      [4, 1],
      [2, 1],
      [1, 1],
    ] as const) {
      expect(resolveDenoJobs(threads, false, undefined)).toBe(expected);
    }
  });
});

describe("coverageDenoJobs", () => {
  test("caps the workers when the caller set none", () => {
    for (const [threads, expected] of [
      [16, 8],
      [8, 8],
      [2, 2],
    ] as const) {
      expect(coverageDenoJobs(undefined, threads)).toBe(expected);
    }
  });

  test("caps the workers for blank and invalid values", () => {
    for (const jobs of INVALID_DENO_JOBS) {
      expect(coverageDenoJobs(jobs, 16)).toBe(8);
    }
  });

  test("leaves a valid explicit count alone", () => {
    for (const jobs of ["12", "1"]) {
      expect(coverageDenoJobs(jobs, 16)).toBeUndefined();
    }
  });
});

describe("precommitDenoJobs", () => {
  test("caps the default, because the run's test step is the coverage gate", () => {
    expect(precommitDenoJobs(32, false, undefined)).toBe(8);
    expect(precommitDenoJobs(16, true, undefined)).toBe(8);
  });

  test("keeps the small-machine floor under the cap", () => {
    for (const threads of [2, 1]) {
      expect(precommitDenoJobs(threads, false, undefined)).toBe(1);
    }
  });

  test("a valid explicit count wins", () => {
    expect(precommitDenoJobs(16, false, "9")).toBe(9);
    expect(precommitDenoJobs(16, true, "1")).toBe(1);
  });

  test("an invalid count falls back to the capped default", () => {
    for (const jobs of INVALID_DENO_JOBS) {
      expect(precommitDenoJobs(32, false, jobs)).toBe(8);
    }
  });
});
