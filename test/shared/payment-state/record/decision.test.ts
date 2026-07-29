import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  decisionStateAgreesWithItsTries,
  type StoredDecision,
} from "#shared/payment-state/record/decision.ts";

describe("what a stored decision may be", () => {
  const accepted: StoredDecision = {
    attemptCount: 0,
    decision: null,
    lastAttemptAt: null,
    lastError: null,
    nextRetryAt: null,
    state: "accepted",
  };
  const waiting: StoredDecision = {
    attemptCount: 1,
    decision: null,
    lastAttemptAt: 5,
    lastError: "enc:1:a:b",
    nextRetryAt: 9,
    state: "retrying",
  };
  const done: StoredDecision = {
    attemptCount: 1,
    decision: "enc:1:a:b",
    lastAttemptAt: 5,
    lastError: null,
    nextRetryAt: null,
    state: "completed",
  };

  test("accepts a decision taken, one waiting to try again, and one done", () => {
    for (const decision of [accepted, waiting, done]) {
      expect(decisionStateAgreesWithItsTries(decision)).toBe(null);
    }
  });

  for (const [name, decision] of [
    [
      "waiting to try again with nothing booked",
      { ...waiting, nextRetryAt: null },
    ],
    [
      "waiting to try again having never tried",
      { ...waiting, attemptCount: 0, lastAttemptAt: null },
    ],
    [
      "waiting to try again with no reason kept",
      { ...waiting, lastError: null },
    ],
    [
      "finished having never tried",
      { ...done, attemptCount: 0, lastAttemptAt: null },
    ],
    ["finished with nothing to say it did", { ...done, decision: null }],
    ["tried but with no time for the try", { ...accepted, attemptCount: 1 }],
    [
      "still waiting to run that has already been tried",
      { ...accepted, attemptCount: 1, lastAttemptAt: 5 },
    ],
  ] as const) {
    test(`refuses a decision ${name}`, () => {
      expect(decisionStateAgreesWithItsTries(decision)).not.toBe(null);
    });
  }
});
