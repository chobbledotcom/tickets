import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  generateScheduledTaskKey,
  isScheduledTaskKey,
  SCHEDULED_KEY_BYTES,
  SCHEDULED_TASK_KEY_ENV,
  validateScheduledTaskKey,
} from "#shared/scheduled-keys.ts";
import { withEnv } from "#test-utils/env.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

describe("scheduled task keys", () => {
  test("generates distinct canonical 256-bit keys", () => {
    const first = generateScheduledTaskKey();
    const second = generateScheduledTaskKey();

    expect(first).not.toBe(second);
    expect(isScheduledTaskKey(first)).toBe(true);
    expect(isScheduledTaskKey(second)).toBe(true);
    expect(SCHEDULED_KEY_BYTES).toBe(32);
  });

  test("recognizes only canonical unpadded keys", () => {
    expect(isScheduledTaskKey(TEST_SCHEDULED_KEY)).toBe(true);
    for (const value of [
      "",
      `${TEST_SCHEDULED_KEY}=`,
      "A".repeat(42),
      "A".repeat(44),
      `${TEST_SCHEDULED_KEY.slice(0, 42)}B`,
      `${TEST_SCHEDULED_KEY.slice(0, 42)}+`,
    ]) {
      expect(isScheduledTaskKey(value)).toBe(false);
    }
  });

  test("accepts one canonical configured key", () => {
    using _env = withEnv({ SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY });
    expect(() => validateScheduledTaskKey()).not.toThrow();
  });

  test("rejects a malformed configured key", () => {
    using _env = withEnv({ SCHEDULED_TASK_KEY: "invalid" });
    expect(() => validateScheduledTaskKey()).toThrow(
      `${SCHEDULED_TASK_KEY_ENV} must be canonical unpadded base64url for exactly ${SCHEDULED_KEY_BYTES} bytes`,
    );
  });
});
