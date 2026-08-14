/** Direct tests for the refund outcome classification. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  classifyReturnedLocalDue,
  classifySubmittedRefund,
  type RefundPageFacts,
} from "#e2e/refund-outcome.ts";

const recordedFacts: RefundPageFacts = {
  deleteActionVisible: true,
  refreshReachable: true,
  refundActionVisible: false,
  refundedVisible: true,
  unfinishedWorkWarningVisible: false,
};

const observingFacts: RefundPageFacts = {
  deleteActionVisible: false,
  refreshReachable: true,
  refundActionVisible: false,
  refundedVisible: false,
  unfinishedWorkWarningVisible: true,
};

const completed = {
  currency: "gbp",
  kind: "completed",
  returnedAmount: 137,
} as const;

const pending = {
  kind: "pending",
  observedAt: "2026-08-14T00:00:00Z",
} as const;

describe("classifying a submitted refund", () => {
  it("records a completed provider refund with the matching local state", () => {
    expect(classifySubmittedRefund(recordedFacts, completed)).toEqual({
      kind: "refund_recorded",
    });
  });

  it("observes a settling provider refund behind the safe blockers", () => {
    expect(classifySubmittedRefund(observingFacts, pending)).toEqual({
      kind: "refund_observing",
    });
  });

  it("fails a completed provider refund the local state disagrees with", () => {
    expect(() =>
      classifySubmittedRefund(
        { ...recordedFacts, refundedVisible: false },
        completed,
      ),
    ).toThrow(/Refunded status is visible/);
    expect(() =>
      classifySubmittedRefund(
        { ...recordedFacts, deleteActionVisible: false },
        completed,
      ),
    ).toThrow(/Delete action is available/);
    expect(() =>
      classifySubmittedRefund(
        { ...recordedFacts, unfinishedWorkWarningVisible: true },
        completed,
      ),
    ).toThrow(/no unfinished-refund warning/);
  });

  it("fails an observing state that still offers a send or destruction", () => {
    expect(() =>
      classifySubmittedRefund(
        { ...observingFacts, refundActionVisible: true },
        pending,
      ),
    ).toThrow(/Refund action is unavailable/);
    expect(() =>
      classifySubmittedRefund(
        { ...observingFacts, deleteActionVisible: true },
        pending,
      ),
    ).toThrow(/Delete action is unavailable/);
    expect(() =>
      classifySubmittedRefund(
        { ...observingFacts, refundedVisible: true },
        pending,
      ),
    ).toThrow(/Refunded status is not shown/);
    expect(() =>
      classifySubmittedRefund(
        { ...observingFacts, refreshReachable: false },
        pending,
      ),
    ).toThrow(/Refresh remains reachable/);
    expect(() =>
      classifySubmittedRefund(
        { ...observingFacts, unfinishedWorkWarningVisible: false },
        pending,
      ),
    ).toThrow(/unfinished-refund warning/);
  });
});

describe("classifying the returned-but-unrecorded state", () => {
  it("accepts the durable warning with sends blocked and refresh reachable", () => {
    expect(() => classifyReturnedLocalDue(observingFacts)).not.toThrow();
  });

  it("fails any control that could move money or destroy the booking", () => {
    expect(() =>
      classifyReturnedLocalDue({
        ...observingFacts,
        refundActionVisible: true,
      }),
    ).toThrow(/Refund action is unavailable/);
    expect(() =>
      classifyReturnedLocalDue({
        ...observingFacts,
        deleteActionVisible: true,
      }),
    ).toThrow(/Delete action is unavailable/);
    expect(() =>
      classifyReturnedLocalDue({ ...observingFacts, refreshReachable: false }),
    ).toThrow(/Refresh remains reachable/);
    expect(() =>
      classifyReturnedLocalDue({ ...observingFacts, refundedVisible: true }),
    ).toThrow(/Refunded status is not shown/);
    expect(() =>
      classifyReturnedLocalDue({
        ...observingFacts,
        unfinishedWorkWarningVisible: false,
      }),
    ).toThrow(/unfinished-refund warning/);
  });
});
