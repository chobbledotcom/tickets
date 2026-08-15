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

describe("classifying a submitted refund", () => {
  it("records a refund whose page shows the Refunded status", () => {
    expect(classifySubmittedRefund(recordedFacts)).toEqual({
      kind: "refund_recorded",
    });
  });

  it("observes a refund whose page has not shown Refunded yet", () => {
    expect(classifySubmittedRefund(observingFacts)).toEqual({
      kind: "refund_observing",
    });
  });

  it("observes even without the one-shot flash warning", () => {
    // The warning lives on the redirect page and can be gone by gathering
    // time; the durable blockers alone define the observing state.
    expect(
      classifySubmittedRefund({
        ...observingFacts,
        unfinishedWorkWarningVisible: false,
      }),
    ).toEqual({ kind: "refund_observing" });
  });

  it("fails a recorded page whose send is somehow still offered", () => {
    expect(() =>
      classifySubmittedRefund({
        ...recordedFacts,
        refundActionVisible: true,
      }),
    ).toThrow(/Refund action is unavailable/);
  });

  it("fails a recorded page missing the Delete action", () => {
    expect(() =>
      classifySubmittedRefund({ ...recordedFacts, deleteActionVisible: false }),
    ).toThrow(/Delete action is available/);
  });

  it("fails a recorded page still showing the warning", () => {
    expect(() =>
      classifySubmittedRefund({
        ...recordedFacts,
        unfinishedWorkWarningVisible: true,
      }),
    ).toThrow(/no unfinished-refund warning/);
  });

  it("fails an observing state that still offers a send or destruction", () => {
    expect(() =>
      classifySubmittedRefund({ ...observingFacts, refundActionVisible: true }),
    ).toThrow(/Refund action is unavailable/);
    expect(() =>
      classifySubmittedRefund({ ...observingFacts, deleteActionVisible: true }),
    ).toThrow(/Delete action is unavailable/);
    expect(() =>
      classifySubmittedRefund({ ...observingFacts, refreshReachable: false }),
    ).toThrow(/Refresh remains reachable/);
  });
});

describe("classifying the returned-but-unrecorded state", () => {
  it("accepts the durable warning with sends blocked and refresh reachable", () => {
    expect(() => classifyReturnedLocalDue(observingFacts)).not.toThrow();
  });

  it("fails without the explicit do-not-refund-again warning", () => {
    expect(() =>
      classifyReturnedLocalDue({
        ...observingFacts,
        unfinishedWorkWarningVisible: false,
      }),
    ).toThrow(/unfinished-refund warning/);
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
      classifyReturnedLocalDue({ ...observingFacts, refundedVisible: true }),
    ).toThrow(/Refunded status is not shown/);
    expect(() =>
      classifyReturnedLocalDue({ ...observingFacts, refreshReachable: false }),
    ).toThrow(/Refresh remains reachable/);
  });
});
