import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PaymentCasePageData } from "#routes/admin/payments/data.ts";
import type { PaymentCaseDecision } from "#shared/db/payments/types.ts";
import { adminPaymentCasePage } from "#templates/admin/payments/detail.tsx";
import {
  formatPaymentMoney,
  paymentCaseEvidence,
  paymentCaseProvider,
  paymentCaseReason,
  paymentCaseResourceRole,
} from "#templates/admin/payments/format.tsx";
import { adminPaymentsPage } from "#templates/admin/payments/list.tsx";
import {
  reviewedPaymentSnapshot,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import {
  legacyPaymentOperatorCase,
  paymentCharge,
  provenPaymentOperatorCase,
} from "#test/shared/payment-runtime/fixtures.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";

const pageData = (): PaymentCasePageData => ({
  accounts: [],
  attendee: { id: 42, name: "Linked buyer" },
  context: provenPaymentOperatorCase(),
  listings: [{ id: 7, name: "Linked listing" }],
});

/** One decision the owner already saved against this case. */
const savedDecision = (
  caseId: number,
  changes: Partial<PaymentCaseDecision> = {},
): PaymentCaseDecision => ({
  attemptCount: 2,
  claim: {
    actorId: 1,
    caseRevision: 1,
    claimedAt: 1_785_024_000_000,
    reason: "Checked the payment",
    reviewed: reviewedPaymentSnapshot(),
    selection: { kind: "refund_remaining" },
  },
  decision: {
    actorId: 1,
    caseRevision: 1,
    decidedAt: 1_785_024_000_000,
    kind: "refund_remaining",
    reason: "Checked the payment",
  },
  id: 9,
  lastAttemptAt: 1_785_024_010_000,
  nextRetryAt: 1_785_024_060_000,
  paymentCaseId: caseId,
  state: "retrying",
  ...changes,
});

describe("admin payment case templates", () => {
  test("formats known and unknown case reasons", () => {
    expect(paymentCaseReason("partial_refund")).toBe(
      "Only part of the payment has been refunded.",
    );
    expect(paymentCaseReason("new_reason")).toBe(
      "The stored payment facts need an owner decision.",
    );
  });

  test("formats current and older payment record roles", () => {
    const current = provenPaymentOperatorCase().case;
    const legacy = legacyPaymentOperatorCase().case;

    expect(paymentCaseProvider(current)).toBe("Stripe");
    expect(paymentCaseProvider(legacy)).toBe("Older payment record");
    expect(paymentCaseResourceRole(current)).toBe("Checkout");
    expect(paymentCaseResourceRole(legacy)).toBe("Older payment record");
  });

  test("describes booking, legacy, found, and unresolved evidence safely", () => {
    const booking = provenPaymentOperatorCase().case;
    const current = provenPaymentOperatorCase();
    if (current.payment.origin !== "current") {
      throw new Error("Expected a current payment");
    }
    booking.evidence = current.payment.value.bookingIntent;
    const legacy = legacyPaymentOperatorCase().case;
    legacy.evidence = {
      fact: "provider",
      legacyPaymentId: "older-payment",
      providerRefundedAt: "",
      source: "attendee_merge",
    };
    const found = provenPaymentOperatorCase().case;
    const unresolved = provenPaymentOperatorCase().case;
    unresolved.evidence = {
      kind: "provider_read",
      read: {
        reason: "mismatched_id",
        requested: SESSION_RESOURCE,
        status: "invalid",
      },
    };

    expect(paymentCaseEvidence(booking)).toBe(
      "The case contains the saved booking details.",
    );
    expect(paymentCaseEvidence(legacy)).toBe(
      "The case contains facts copied from an older payment record.",
    );
    expect(paymentCaseEvidence(found)).toBe(
      "The payment service reports that the payment was paid.",
    );
    expect(paymentCaseEvidence(unresolved)).toBe(
      "The saved payment service response did not pass all checks.",
    );
  });

  test("formats minor units with the currency's decimal places", () => {
    expect(formatPaymentMoney({ amount: 1_050, currency: "GBP" })).toBe(
      "£10.50",
    );
    expect(formatPaymentMoney({ amount: 1_000, currency: "GBP" })).toBe("£10");
  });

  test("renders payment facts, safe links, and an unselected decision", () => {
    const html = adminPaymentCasePage(pageData(), OWNER_SESSION);

    expect(html).toContain("Linked buyer");
    expect(html).toContain('href="/admin/attendees/42"');
    expect(html).toContain("Linked listing");
    expect(html).toContain('href="/admin/listing/7"');
    expect(html).toContain("Choose what happens");
    expect(html).toContain('name="case_revision"');
    expect(html).not.toMatch(/<option[^>]+selected/u);
  });

  test("shows unknown and mixed money without unsafe links", () => {
    const legacy = legacyPaymentOperatorCase();
    const legacyHtml = adminPaymentCasePage(
      { accounts: [], attendee: null, context: legacy, listings: [] },
      OWNER_SESSION,
    );
    const mixed = pageData();
    mixed.context.charges.push(
      paymentCharge({
        captured: { amount: 500, currency: "EUR" },
        id: 2,
        providerReference: {
          id: "pi_eur",
          kind: "stripe_payment_intent",
          parentId: "cs_test_1",
          provider: "stripe",
        },
        refunded: { amount: 0, currency: "EUR" },
      }),
    );
    const mixedHtml = adminPaymentCasePage(mixed, OWNER_SESSION);

    expect(legacyHtml).toContain("Not known");
    expect(legacyHtml).toContain(
      "The stored facts do not support a safe decision yet.",
    );
    expect(legacyHtml).not.toContain("/admin/attendees/");
    expect(legacyHtml).not.toContain("/admin/listing/");
    expect(mixedHtml).toContain("More than one currency");
  });

  /** The page for a case waiting to be checked again, carrying this one
   *  decision the owner already saved. */
  const retryingCasePage = (
    changes: Partial<PaymentCaseDecision>,
    flash: Parameters<typeof adminPaymentCasePage>[2] = {},
  ): string => {
    const data = pageData();
    data.context.case.state = "retrying";
    data.context.case.nextReconcileAt = 1_785_024_060_000;
    data.context.decisions = [savedDecision(data.context.case.id, changes)];
    return adminPaymentCasePage(data, OWNER_SESSION, flash);
  };

  test("renders retry timing, saved decisions, and flash messages", () => {
    const html = retryingCasePage(
      {},
      { error: "Review this case.", success: "Saved." },
    );

    expect(html).toContain("The next check is due after");
    expect(html).toContain("waiting to try again");
    expect(html).toContain("Retry saved decision");
    expect(html).toContain("/retry/9");
    expect(html).toContain("Review this case.");
    expect(html).not.toContain("Choose what happens");
  });

  test("shows no retry timing for a decision that has finished", () => {
    const html = retryingCasePage({ nextRetryAt: null, state: "completed" });

    // The case's own next check still shows; the decision's does not.
    expect(html).toContain("The next check is due after");
    expect(html).not.toContain("waiting to try again");
    expect(html).not.toContain("/retry/9");
  });

  test("links only cases that need an owner decision", () => {
    const needsAction = provenPaymentOperatorCase().case;
    const retrying = legacyPaymentOperatorCase().case;
    retrying.id = 2;
    retrying.state = "retrying";
    retrying.nextReconcileAt = 1_785_024_060_000;
    retrying.alertedAt = null;

    const html = adminPaymentsPage(
      [needsAction, retrying],
      OWNER_SESSION,
      "Cases loaded.",
    );

    expect(html).toContain('href="/admin/payments/1"');
    expect(html).not.toContain('href="/admin/payments/2"');
    expect(html).toContain("Trying again");
    expect(html).toContain("Cases loaded.");
  });

  test("renders the empty payment case list", () => {
    expect(adminPaymentsPage([], OWNER_SESSION)).toContain(
      "No payment cases need attention.",
    );
  });
});
