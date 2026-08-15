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
  it("records a refund whose local state shows it completed", () => {
    expect(classifySubmittedRefund(recordedFacts)).toEqual({
      kind: "refund_recorded",
    });
  });

  it("observes a refund whose local state shows unfinished work", () => {
    expect(classifySubmittedRefund(observingFacts)).toEqual({
      kind: "refund_observing",
    });
  });

  it("classifies by the local warning even when other facts still settle", () => {
    // A provider may complete moments after submission; the app's honest
    // observing record still classifies as observing.
    expect(classifySubmittedRefund(observingFacts)).toEqual({
      kind: "refund_observing",
    });
  });

  it("fails an unrecorded page that claims no warning either", () => {
    expect(() =>
      classifySubmittedRefund({
        ...observingFacts,
        refundedVisible: false,
        unfinishedWorkWarningVisible: false,
      }),
    ).toThrow(/not show the refund as recorded/);
  });

  it("fails a recorded page missing the Refunded status", () => {
    expect(() =>
      classifySubmittedRefund({ ...recordedFacts, refundedVisible: false }),
    ).toThrow(/Refunded status is visible/);
  });

  it("fails a recorded page without the Delete action", () => {
    expect(() =>
      classifySubmittedRefund({ ...recordedFacts, deleteActionVisible: false }),
    ).toThrow(/Delete action is available/);
  });

  it("fails a recorded page still showing the warning", () => {
    // The warning routes to the observing branch, whose other claims then
    // catch the mismatched facts.
    expect(() =>
      classifySubmittedRefund({
        ...recordedFacts,
        deleteActionVisible: true,
        refundedVisible: true,
        unfinishedWorkWarningVisible: true,
      }),
    ).toThrow(/Refunded status is not shown/);
  });

  it("fails an observing state that still offers a send or destruction", () => {
    expect(() =>
      classifySubmittedRefund({ ...observingFacts, refundActionVisible: true }),
    ).toThrow(/Refund action is unavailable/);
    expect(() =>
      classifySubmittedRefund({ ...observingFacts, deleteActionVisible: true }),
    ).toThrow(/Delete action is unavailable/);
    expect(() =>
      classifySubmittedRefund({ ...observingFacts, refundedVisible: true }),
    ).toThrow(/Refunded status is not shown/);
    expect(() =>
      classifySubmittedRefund({ ...observingFacts, refreshReachable: false }),
    ).toThrow(/Refresh remains reachable/);
    expect(() =>
      classifySubmittedRefund({
        ...observingFacts,
        unfinishedWorkWarningVisible: false,
      }),
    ).toThrow(/refund as recorded/);
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
