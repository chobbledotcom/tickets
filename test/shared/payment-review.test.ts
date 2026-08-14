import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { WithheldRefund } from "#shared/payment/admit-refund.ts";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import {
  reportFailedRefundAttempt,
  reportWithheldRefund,
} from "#shared/payment-review.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { initSentry } from "#shared/sentry.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { resetSentry, sentryRequestBody } from "#test-utils/sentry.ts";

const PRIVATE_REFERENCE = "pi_private_refund_reference";
const where = {
  attendeeId: 7,
  listingId: 3,
  provider: "stripe" as const,
};

describe("reporting a withheld refund", () => {
  const errors = setupErrorSpy();

  test("a disagreement an owner must resolve is reported without a reference", () => {
    reportWithheldRefund(
      { issue: { kind: "partial_refund" }, kind: "refused" },
      where,
    );

    // The classified fan-out is what puts this in the activity log, the ntfy
    // ping and Sentry. Before this it was a debug line, which reaches nobody.
    expect(errors.calls).toHaveLength(1);
    expect(errors.lastMessage()).not.toContain(PRIVATE_REFERENCE);
    expect(errors.lastMessage()).toContain("partial_refund");
    expect(errors.lastMessage()).toContain("an owner needs to look at it");
  });

  test("keeps the raw reference out of Sentry and preserves typed ids", async () => {
    using _env = withEnv({
      NTFY_URL: undefined,
      SENTRY_URL: "https://abc123@bugs.example.test/2",
    });
    const fetchStub = stubFetch(() => new Response("{}", { status: 200 }));
    try {
      await initSentry();
      await runWithPendingWork(() => {
        reportWithheldRefund(
          { issue: { kind: "partial_refund" }, kind: "refused" },
          where,
        );
        return Promise.resolve();
      });

      const body = sentryRequestBody(fetchStub.calls);
      expect(body).not.toContain(PRIVATE_REFERENCE);
      expect(body).toContain('"listingId":"3"');
      expect(body).toContain('"attendeeId":"7"');
    } finally {
      fetchStub.restore();
      resetSentry();
    }
  });

  test("names the conflict it found, not just that there was one", () => {
    reportWithheldRefund(
      { issue: { kind: "refund_exceeds_capture" }, kind: "refused" },
      where,
    );

    // A second kind, so the report is proved to carry the one it was given
    // rather than a fixed word.
    expect(errors.lastMessage()).toContain("refund_exceeds_capture");
  });

  const ordinary: WithheldRefund[] = [
    { kind: "already_returned" },
    { kind: "in_flight" },
    {
      kind: "read_failed",
      read: { reason: "network_error", status: "unavailable" },
    },
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

  for (const read of [
    { status: "missing" },
    { reason: "malformed_response", status: "invalid" },
  ] as const) {
    test(`${read.status} provider evidence is an incident`, () => {
      reportWithheldRefund({ kind: "read_failed", read }, where);

      expect(errors.calls).toHaveLength(1);
      expect(errors.lastMessage()).toContain(
        read.status === "missing" ? "does not exist" : "invalid",
      );
      expect(errors.lastMessage()).toContain("an owner needs to look at it");
    });
  }

  const failedAttempts: Extract<
    RefundAttemptResult,
    { kind: "not_sent" | "rejected" | "uncertain" }
  >[] = [
    { kind: "not_sent", reason: "not_configured" },
    { kind: "rejected", reason: "rejected" },
    { kind: "uncertain", reason: "network_error" },
  ];

  for (const attempt of failedAttempts) {
    test(`reports a ${attempt.kind} provider attempt without its reference`, () => {
      reportFailedRefundAttempt(attempt, where);

      expect(errors.calls).toHaveLength(1);
      expect(errors.lastMessage()).toContain(
        `Refund ${attempt.kind} for stripe payment (${attempt.reason})`,
      );
      expect(errors.lastMessage()).not.toContain(PRIVATE_REFERENCE);
    });
  }
});
