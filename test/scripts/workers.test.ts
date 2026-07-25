import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { precommitWorkerCount, resolveDenoJobs } from "#scripts/workers.ts";

describe("precommitWorkerCount", () => {
  test("uses every thread in CI", () => {
    expect(precommitWorkerCount(16, true)).toBe(16);
    expect(precommitWorkerCount(1, true)).toBe(1);
  });

  test("uses half the threads minus one locally", () => {
    expect(precommitWorkerCount(16, false)).toBe(7);
    expect(precommitWorkerCount(8, false)).toBe(3);
  });

  test("never drops below one locally", () => {
    expect(precommitWorkerCount(4, false)).toBe(1);
    expect(precommitWorkerCount(2, false)).toBe(1);
    expect(precommitWorkerCount(1, false)).toBe(1);
  });
});

describe("resolveDenoJobs", () => {
  test("returns undefined when the operator already set DENO_JOBS", () => {
    expect(resolveDenoJobs(16, false, "4")).toBe(undefined);
    expect(resolveDenoJobs(16, true, "1")).toBe(undefined);
  });

  test("returns the CI worker count when unset in CI", () => {
    expect(resolveDenoJobs(16, true, undefined)).toBe(16);
  });

  test("returns the capped local count when unset locally", () => {
    expect(resolveDenoJobs(16, false, undefined)).toBe(7);
    expect(resolveDenoJobs(8, false, undefined)).toBe(3);
  });
});
