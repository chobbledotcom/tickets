import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  callTimeLeftMs,
  FAILURE_RETRY_INTERVAL_MS,
  RESULT_WRITE_MARGIN_MS,
} from "#shared/caldav/pacing.ts";

describe("callTimeLeftMs", () => {
  test("gives a call the run window up to the result-write margin", () => {
    // 30s deadline, nothing spent: 30s minus the 2s write margin = 28s.
    expect(callTimeLeftMs(30_000, 0)).toBe(28_000);
  });

  test("shrinks as the deadline approaches", () => {
    // 10s later, 18s of call budget remains.
    expect(callTimeLeftMs(30_000, 10_000)).toBe(18_000);
  });

  test("is exactly zero at the margin boundary — stop calling out", () => {
    expect(callTimeLeftMs(RESULT_WRITE_MARGIN_MS, 0)).toBe(0);
  });

  test("goes negative once inside the margin", () => {
    expect(callTimeLeftMs(RESULT_WRITE_MARGIN_MS, 1_000)).toBe(-1_000);
  });
});

describe("pacing constants", () => {
  test("reserves two seconds to record the last call's result", () => {
    expect(RESULT_WRITE_MARGIN_MS).toBe(2_000);
  });

  test("waits five minutes before retrying a failed item", () => {
    expect(FAILURE_RETRY_INTERVAL_MS).toBe(300_000);
  });
});
