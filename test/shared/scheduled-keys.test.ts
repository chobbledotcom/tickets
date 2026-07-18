import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  generateScheduledTaskKey,
  isScheduledTaskKey,
  SCHEDULED_KEY_BYTES,
  SCHEDULED_TASK_KEY_ENV,
  SCHEDULED_TASK_KEY_NEXT_ENV,
  validateScheduledTaskKeys,
} from "#shared/scheduled-keys.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  TEST_SCHEDULED_KEY,
  TEST_SCHEDULED_NEXT_KEY,
} from "#test-utils/scheduled.ts";

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

  test("accepts canonical active and next slots", () => {
    using _env = withEnv({
      SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
      SCHEDULED_TASK_KEY_NEXT: TEST_SCHEDULED_NEXT_KEY,
    });
    expect(() => validateScheduledTaskKeys()).not.toThrow();
  });

  test("rejects a malformed configured slot", () => {
    for (const name of [SCHEDULED_TASK_KEY_ENV, SCHEDULED_TASK_KEY_NEXT_ENV]) {
      using _env = withEnv({
        SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
        [name]: "invalid",
      });
      expect(() => validateScheduledTaskKeys()).toThrow(
        `${name} must be canonical unpadded base64url for exactly 32 bytes`,
      );
    }
  });

  test("rejects a next slot without an active slot", () => {
    using _env = withEnv({
      SCHEDULED_TASK_KEY: undefined,
      SCHEDULED_TASK_KEY_NEXT: TEST_SCHEDULED_NEXT_KEY,
    });
    expect(() => validateScheduledTaskKeys()).toThrow(
      "SCHEDULED_TASK_KEY_NEXT requires SCHEDULED_TASK_KEY",
    );
  });

  test("rejects duplicate active and next slots", () => {
    using _env = withEnv({
      SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
      SCHEDULED_TASK_KEY_NEXT: TEST_SCHEDULED_KEY,
    });
    expect(() => validateScheduledTaskKeys()).toThrow(
      "Scheduled task keys must be different",
    );
  });
});
