import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_SPEC_WORKERS, specWorkerCount } from "#scripts/specs/parallel.ts";

describe("Cucumber worker count", () => {
  test("keeps zero and one selected case in the coordinator", () => {
    expect(specWorkerCount(0, "4", 8)).toBe(0);
    expect(specWorkerCount(1, "4", 8)).toBe(0);
    // Even with workers to spare, a single case is not worth a worker.
    expect(specWorkerCount(1, "8", 8)).toBe(0);
  });

  test("does not create empty workers", () => {
    expect(specWorkerCount(2, "4", 8)).toBe(2);
    expect(specWorkerCount(3, "2", 8)).toBe(2);
  });

  test("uses DENO_JOBS then hardware concurrency within the safety cap", () => {
    expect(specWorkerCount(10, "3", 8)).toBe(3);
    expect(specWorkerCount(10, "invalid", 8)).toBe(MAX_SPEC_WORKERS);
    expect(specWorkerCount(2, undefined, 1)).toBe(1);
    // A machine that reports no cores still gets one worker.
    expect(specWorkerCount(2, undefined, 0)).toBe(1);
  });
});
