import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { WithheldRefund } from "#shared/payment/admit-refund.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

const where = { attendeeId: 7, listingId: 3, paymentReference: "pi_x" };

describe("reporting a withheld refund", () => {
  const errors = setupErrorSpy();

  test("a disagreement an owner must resolve is reported, not swallowed", () => {
    reportWithheldRefund(
      { issue: { kind: "partial_refund" }, kind: "refused" },
      where,
    );

    // The classified fan-out is what puts this in the activity log, the ntfy
    // ping and Sentry. Before this it was a debug line, which reaches nobody.
    expect(errors.calls).toHaveLength(1);
    expect(errors.lastMessage()).toContain("pi_x");
    expect(errors.lastMessage()).toContain("partial_refund");
    expect(errors.lastMessage()).toContain("an owner needs to look at it");
  });

  test("names the conflict it found, not just that there was one", () => {
    reportWithheldRefund(
      { issue: { kind: "failed_refund" }, kind: "refused" },
      where,
    );

    expect(errors.lastMessage()).toContain("failed_refund");
  });

  const ordinary: WithheldRefund[] = [
    { kind: "already_returned" },
    { kind: "in_flight" },
    { kind: "unreadable" },
  ];

  for (const admission of ordinary) {
    test(`${admission.kind} is an answer, not an incident`, () => {
      reportWithheldRefund(admission, where);

      // These happen in normal running — money already back, a refund still
      // settling, a provider that could not be reached. Reporting them would
      // train the operator to ignore the ones that matter.
      expect(errors.calls).toHaveLength(0);
    });
  }
});
