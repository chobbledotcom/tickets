import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import {
  EMPTY_ROW_STATE,
  isEmptyRowState,
  type PaymentRowState,
  readRowState,
  writeRowState,
} from "#shared/payment/row-state.ts";
import { reviewCase } from "#test-utils/payment-claim.ts";

const CONTEXT = "processed_payments.failure_data";

const FULL: PaymentRowState = {
  claim: {
    attendeeIds: [12],
    commandId: "full-command",
    phase: "checking",
    scope: "attendee_set",
    writtenAt: "2026-08-10T12:00:00.000Z",
  },
  outcome: { error: "Sold out", refunded: true, status: 409 },
  review: reviewCase({ kind: "partial_refund" }),
};

describe("readRowState", () => {
  test("round-trips every field", () => {
    expect(readRowState(writeRowState(FULL, CONTEXT), CONTEXT)).toEqual(FULL);
  });

  test("reads a row written before this record existed as an outcome", () => {
    const legacy = JSON.stringify({
      error: "Payment failed",
      refunded: true,
      status: 400,
    });
    expect(readRowState(legacy, CONTEXT)).toEqual({
      outcome: { error: "Payment failed", refunded: true, status: 400 },
    });
  });

  test("reads a legacy row carrying only the message", () => {
    expect(readRowState(JSON.stringify({ error: "Gone" }), CONTEXT)).toEqual({
      outcome: { error: "Gone" },
    });
  });

  test("upgrades a legacy review reason into one stable review case", () => {
    expect(
      readRowState(
        JSON.stringify({ review: { kind: "partial_refund" } }),
        CONTEXT,
      ),
    ).toEqual({
      review: {
        caseId: "legacy:partial_refund",
        reason: { kind: "partial_refund" },
      },
    });
  });

  test("a claim-only record is not mistaken for a legacy outcome", () => {
    const claimOnly: PaymentRowState = {
      claim: {
        attendeeIds: [7],
        commandId: "claim-only-command",
        phase: "checking",
        scope: "attendee_set",
        writtenAt: "2026-08-10T12:00:00.000Z",
      },
    };
    expect(readRowState(writeRowState(claimOnly, CONTEXT), CONTEXT)).toEqual(
      claimOnly,
    );
  });

  test("refuses a record whose claim names an unknown scope", () => {
    const rogue = JSON.stringify({
      claim: {
        attendeeIds: [7],
        commandId: "rogue-command",
        phase: "checking",
        scope: "sweep",
        writtenAt: "2026-08-10T12:00:00.000Z",
      },
    });
    expect(() => readRowState(rogue, CONTEXT)).toThrow(CONTEXT);
  });

  test("refuses a record whose review names a problem the judge cannot produce", () => {
    const rogue = JSON.stringify({ review: { kind: "not_a_real_conflict" } });
    expect(() => readRowState(rogue, CONTEXT)).toThrow(CONTEXT);
  });

  test("round-trips every operational owner-review reason", () => {
    const reasons = [
      "shared_reference",
      "partially_returned_obligation",
    ] as const;
    expect(
      reasons.map((kind) =>
        readRowState(
          writeRowState({ review: reviewCase({ kind }) }, CONTEXT),
          CONTEXT,
        ),
      ),
    ).toEqual(
      reasons.map((kind) => ({
        review: reviewCase({ kind }),
      })),
    );
  });

  test("refuses a claim with no written-at time", () => {
    const rogue = JSON.stringify({
      claim: {
        attendeeIds: [7],
        commandId: "no-time-command",
        phase: "checking",
        scope: "attendee_set",
      },
    });
    expect(() => readRowState(rogue, CONTEXT)).toThrow(CONTEXT);
  });

  test("refuses an attendee claim that names no attendee", () => {
    const rogue = JSON.stringify({
      claim: {
        attendeeIds: [],
        commandId: "no-attendee-command",
        phase: "checking",
        scope: "attendee_set",
        writtenAt: "2026-08-10T12:00:00.000Z",
      },
    });
    expect(() => readRowState(rogue, CONTEXT)).toThrow(CONTEXT);
  });

  for (const attendeeIds of [
    [7, 7],
    [9, 7],
  ]) {
    test(`refuses claim attendee ids ${attendeeIds.join(", ")}`, () => {
      const rogue = JSON.stringify({
        claim: {
          attendeeIds,
          commandId: "unordered-attendees-command",
          phase: "checking",
          scope: "attendee_set",
          writtenAt: "2026-08-10T12:00:00.000Z",
        },
      });

      expect(() => readRowState(rogue, CONTEXT)).toThrow(CONTEXT);
    });
  }
});

describe("writeRowState", () => {
  test("keeps the fields a writer did not touch", () => {
    const withClaimReleased: PaymentRowState = {
      outcome: FULL.outcome,
      review: FULL.review,
    };
    const stored = writeRowState(withClaimReleased, CONTEXT);
    expect(readRowState(stored, CONTEXT)).toEqual(withClaimReleased);
  });

  test("refuses to store a claim the reader could not trust", () => {
    const bad = {
      claim: {
        attendeeIds: [7],
        commandId: "bad-command",
        phase: "working",
        scope: "attendee_set",
        writtenAt: "now",
      },
    } as unknown as PaymentRowState;
    expect(() => writeRowState(bad, CONTEXT)).toThrow(CONTEXT);
  });
});

describe("isEmptyRowState", () => {
  test("the empty record carries nothing", () => {
    expect(isEmptyRowState(EMPTY_ROW_STATE)).toBe(true);
  });

  const CARRIED: [string, PaymentRowState][] = [
    ["a claim", { claim: FULL.claim }],
    ["an outcome", { outcome: FULL.outcome }],
    ["a review marker", { review: FULL.review }],
    [
      "an unrecorded refund",
      { unrecorded: { returnedAt: "2026-08-10T12:00:00.000Z" } },
    ],
  ];
  for (const [what, state] of CARRIED) {
    test(`a record carrying ${what} is not empty`, () => {
      expect(isEmptyRowState(state)).toBe(false);
    });
  }
});
