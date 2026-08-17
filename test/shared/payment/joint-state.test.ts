import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AuthorityFact,
  assertJointStateLegal,
  ILLEGAL_JOINT_STATES,
  illegalJointReasonOrNull,
  type JointRowFact,
  jointRowFactOf,
} from "#shared/payment/joint-state.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";

const HELD: PaymentRowState = {
  claim: {
    attendeeIds: [4],
    commandId: "cmd_joint",
    phase: "checking",
    scope: "attendee_set",
    writtenAt: "2026-08-17T10:00:00.000Z",
  },
};

const SETTLED: PaymentRowState = { outcome: { error: "kept" } };

const ROW_FACTS: readonly JointRowFact[] = [
  "free_reserved",
  "free_finalized",
  "claim",
  "review",
  "unrecorded",
  "claim_review",
  "claim_unrecorded",
  "review_unrecorded",
  "claim_review_unrecorded",
  "settled",
];

const AUTHORITY_FACTS: readonly AuthorityFact[] = [
  "absent",
  "ready",
  "send_armed",
  "observing",
  "completed_due",
  "completed_recorded",
  "needs_owner_choice",
  "needs_provider_check",
];

describe("payment joint state", () => {
  test("every declared entry names known facts, once each", () => {
    const seen = new Set<string>();
    for (const entry of ILLEGAL_JOINT_STATES) {
      expect(AUTHORITY_FACTS).toContain(entry.authority);
      expect(entry.reason.length).toBeGreaterThan(0);
      for (const row of entry.rows) {
        expect(ROW_FACTS).toContain(row);
        const key = `${row}×${entry.authority}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });

  test("splits a free row by phase and maps stored states to their node", () => {
    expect(jointRowFactOf({}, false)).toBe("free_reserved");
    expect(jointRowFactOf({}, true)).toBe("free_finalized");
    expect(jointRowFactOf(HELD, false)).toBe("claim");
    expect(jointRowFactOf(SETTLED, true)).toBe("settled");
  });

  test("an armed send is illegal on every row without a held claim", () => {
    for (const row of ROW_FACTS) {
      const reason = illegalJointReasonOrNull(row, "send_armed");
      if (row.startsWith("claim")) expect(reason, row).toBeNull();
      else expect(reason, row).toContain("armed");
    }
  });

  test("a held claim is illegal over references with no charge", () => {
    expect(illegalJointReasonOrNull("claim", "absent")).toContain("claim");
    expect(illegalJointReasonOrNull("free_finalized", "absent")).toBeNull();
    expect(illegalJointReasonOrNull("settled", "absent")).toBeNull();
  });

  test("answers every combination without throwing", () => {
    for (const row of ROW_FACTS) {
      for (const authority of AUTHORITY_FACTS) {
        const reason = illegalJointReasonOrNull(row, authority);
        expect(
          reason === null || reason.length > 0,
          `${row}×${authority}`,
        ).toBe(true);
      }
    }
  });

  test("the assertion names the flow, the facts, and the broken invariant", () => {
    expect(() =>
      assertJointStateLegal(
        "settled",
        ["completed_recorded", "send_armed"],
        "resume",
      ),
    ).toThrow(
      /resume: row settled cannot carry a send_armed charge — A provider send/,
    );
    assertJointStateLegal(
      "claim",
      AUTHORITY_FACTS.filter((f) => f !== "absent"),
      "dispatch",
    );
    assertJointStateLegal("free_finalized", [], "empty");
  });
});
