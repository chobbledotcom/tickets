import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describe("reportRefundNotRecorded", () => {
  const errors = setupErrorSpy();

  test("returns the operator-facing catalog message", () => {
    expect(reportRefundNotRecorded()).toBe(t("error.refund_not_recorded"));
  });

  test("reports the broken promise with its key and record ids", () => {
    reportRefundNotRecorded({ attendeeId: 12, listingId: 7 });
    expect(errors.lastMessage()).toBe(
      '[Error] E_INVARIANT_REPORTED listing=7 attendee=12 detail="error.refund_not_recorded"',
    );
  });

  test("reports without record ids when none are given", () => {
    reportRefundNotRecorded();
    expect(errors.lastMessage()).toBe(
      '[Error] E_INVARIANT_REPORTED detail="error.refund_not_recorded"',
    );
  });
});
