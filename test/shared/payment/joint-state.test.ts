import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AuthorityFact,
  assertJointStateLegal,
  authorityFactOf,
  ILLEGAL_JOINT_STATES,
  illegalJointReasonOrNull,
  type JointRowFact,
  jointRowFactOf,
} from "#shared/payment/joint-state.ts";
import { openPaymentReview } from "#shared/payment/review.ts";
import { ROW_NODES } from "#shared/payment/row-machine-spec.ts";
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

const review = openPaymentReview({ kind: "shared_reference" });

// Derived from the production node list, so a row machine that grows a node
// grows these checks with it.
const ROW_FACTS: readonly JointRowFact[] = [
  "free_reserved",
  "free_finalized",
  ...ROW_NODES.flatMap((node) => (node.id === "free" ? [] : [node.id])),
];

// One entry per fact the seam can name — the machine's own stored names
// plus "absent" for a reference with no charge. The record's key type
// demands every member of the production AuthorityFact union, so an
// authority state this test does not enumerate stops the file compiling.
const AUTHORITY_FACT_ENTRIES: { readonly [Fact in AuthorityFact]: Fact } = {
  absent: "absent",
  completed: "completed",
  needs_owner_choice: "needs_owner_choice",
  needs_provider_check: "needs_provider_check",
  observing: "observing",
  ready: "ready",
  send_armed: "send_armed",
};

const AUTHORITY_FACTS: readonly AuthorityFact[] = Object.values(
  AUTHORITY_FACT_ENTRIES,
);

describe("payment joint state", () => {
  test("every declared entry names known facts with a real reason", () => {
    for (const entry of ILLEGAL_JOINT_STATES) {
      expect(AUTHORITY_FACTS).toContain(entry.authority);
      expect(entry.reason.length).toBeGreaterThan(0);
      for (const row of entry.rows) expect(ROW_FACTS).toContain(row);
    }
  });

  test("no combination is declared twice", () => {
    const combinations = ILLEGAL_JOINT_STATES.flatMap((entry) =>
      entry.rows.map((row) => `${row}×${entry.authority}`),
    );
    expect(new Set(combinations).size).toBe(combinations.length);
  });

  test("splits a free row by phase", () => {
    expect(jointRowFactOf({}, false)).toBe("free_reserved");
    expect(jointRowFactOf({}, true)).toBe("free_finalized");
  });

  test("names a stored row by its live work", () => {
    expect(jointRowFactOf(HELD, false)).toBe("claim");
    expect(jointRowFactOf(SETTLED, true)).toBe("settled");
    expect(jointRowFactOf({ ...HELD, review }, false)).toBe("claim_review");
  });

  test("a pending outcome rides beside live work without changing the fact", () => {
    // A stored row keeps its pending outcome beside its live work through
    // the whole crash window — the live work names the fact, whichever kind
    // it is, and the outcome rides along.
    expect(jointRowFactOf({ ...HELD, ...SETTLED }, false)).toBe("claim");
    expect(jointRowFactOf({ review, ...SETTLED }, false)).toBe("review");
    expect(
      jointRowFactOf(
        { unrecorded: { returnedAt: "2026-08-17T10:00:00.000Z" }, ...SETTLED },
        false,
      ),
    ).toBe("unrecorded");
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

  test("each declared reason tells its whole story", () => {
    // The reason is the diagnosis an operator reads when the seam trips, so
    // its exact words are part of the contract, not decoration.
    expect(illegalJointReasonOrNull("free_reserved", "send_armed")).toBe(
      "A provider send is armed only under a held claim, and the claim is " +
        "released only after the send completes — an armed charge on a row " +
        "nobody holds has no flow that finishes it.",
    );
    expect(illegalJointReasonOrNull("claim", "absent")).toBe(
      "A claim is admitted only over references that carry a charge, so a " +
        "held row whose references have no charge cannot have been claimed.",
    );
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

  test("maps stored authority names", () => {
    expect(authorityFactOf(null)).toBe("absent");
    expect(authorityFactOf("completed")).toBe("completed");
    expect(authorityFactOf("send_armed")).toBe("send_armed");
  });

  test("refuses an authority name it has never heard of", () => {
    expect(() => authorityFactOf("half_done")).toThrow(
      "Unknown refund authority state name: half_done",
    );
  });

  test("the assertion names the flow, the facts, and the broken invariant", () => {
    expect(() =>
      assertJointStateLegal("settled", ["completed", "send_armed"], "resume"),
    ).toThrow(
      /resume: row settled cannot carry a send_armed charge — A provider send/,
    );
  });

  test("legal combinations pass the assertion", () => {
    assertJointStateLegal(
      "claim",
      AUTHORITY_FACTS.filter((fact) => fact !== "absent"),
      "dispatch",
    );
    assertJointStateLegal("free_finalized", [], "empty");
  });
});
