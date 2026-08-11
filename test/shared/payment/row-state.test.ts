import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import {
  EMPTY_ROW_STATE,
  isEmptyRowState,
  type PaymentRowState,
  readRowState,
  writeRowState,
} from "#shared/payment/row-state.ts";

const CONTEXT = "processed_payments.failure_data";

const FULL: PaymentRowState = {
  claim: {
    attendeeId: 12,
    capability: "keyless",
    scope: "attendee_set",
    writtenAt: "2026-08-10T12:00:00.000Z",
  },
  outcome: { error: "Sold out", refunded: true, status: 409 },
  review: { kind: "partial_refund" },
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

  test("a claim-only record is not mistaken for a legacy outcome", () => {
    const claimOnly: PaymentRowState = {
      claim: {
        attendeeId: 7,
        capability: "keyed",
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
        capability: "keyed",
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
      "historical_refund_unverified",
    ] as const;
    expect(
      reasons.map((kind) =>
        readRowState(
          writeRowState({ review: { kind } }, CONTEXT),
          CONTEXT,
        )
      ),
    ).toEqual(reasons.map((kind) => ({ review: { kind } })));
  });

  test("refuses a claim with no written-at time", () => {
    const rogue = JSON.stringify({
      claim: { attendeeId: 7, capability: "keyed", scope: "attendee_set" },
    });
    expect(() => readRowState(rogue, CONTEXT)).toThrow(CONTEXT);
  });

  test("refuses an attendee claim that names no attendee", () => {
    const rogue = JSON.stringify({
      claim: {
        capability: "keyless",
        scope: "attendee_set",
        writtenAt: "2026-08-10T12:00:00.000Z",
      },
    });
    expect(() => readRowState(rogue, CONTEXT)).toThrow(CONTEXT);
  });
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
        attendeeId: 7,
        capability: "guessed",
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
  ];
  for (const [what, state] of CARRIED) {
    test(`a record carrying ${what} is not empty`, () => {
      expect(isEmptyRowState(state)).toBe(false);
    });
  }
});
