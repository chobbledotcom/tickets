import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  adminBlockedRefundAttendeePage,
  adminPaymentReviewPage,
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
  adminResendNotificationPage,
  PaymentDetails,
} from "#templates/admin/attendees.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("attendee payment details panel", () => {
  beforeEach(setupAdminPageTest);

  test("renders nothing when there is no payment and no refresh control", () => {
    expect(
      PaymentDetails({
        attendee: testAttendee(),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    ).toBeNull();
    expect(
      PaymentDetails({
        attendee: testAttendee(),
        refresh: { kind: "none" },
        showBalanceLink: true,
      }),
    ).toBeNull();
  });

  test("names the payment, the amount paid, and the refund state", () => {
    const html = String(
      PaymentDetails({
        attendee: testAttendee({
          payment_id: "pi_123",
          price_paid: "1500",
        }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    expect(html).toContain('<div class="prose"><h3>Payment Details</h3>');
    expect(html).toContain("<strong>Payment ID:</strong> pi_123");
    expect(html).toContain("<strong>Amount Paid:</strong> £15");
    expect(html).toContain("<strong>Refund Status:</strong> Not refunded");
    // A fully paid attendee shows no outstanding balance line.
    expect(html).not.toContain("Balance outstanding");
  });

  test("a hex-looking price parses as decimal, so nothing was paid", () => {
    // parseInt(x, 10) reads "0x1A" as 0; a zero radix would read it as 26.
    const html = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_hex", price_paid: "0x1A" }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    expect(html).toContain("Payment ID");
    expect(html).not.toContain("Amount Paid");
    // One minor unit still counts as paid.
    const penny = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_one", price_paid: "1" }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    expect(penny).toContain("Amount Paid:");
  });

  test("the refunded state shows the refund badge", () => {
    const html = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_9", refunded: true }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    expect(html).toContain("Refunded");
    expect(html).not.toContain("Not refunded");
  });

  test("an outstanding balance links the ledger only for permitted viewers", () => {
    const owed = testAttendee({
      payment_id: "pi_5",
      remaining_balance: 400,
    });
    const linked = String(
      PaymentDetails({
        attendee: owed,
        refresh: { kind: "none" },
        showBalanceLink: true,
      }),
    );
    expect(linked).toContain("Balance outstanding:</strong> £4 — <a href=");
    expect(linked).toContain(
      '<a href="/admin/attendees/1/ledger">View money changes and payment link</a>',
    );

    const unlinked = String(
      PaymentDetails({
        attendee: owed,
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    expect(unlinked).toContain("Balance outstanding");
    expect(unlinked).not.toContain("/ledger");

    // One minor unit still counts as outstanding.
    const penny = String(
      PaymentDetails({
        attendee: testAttendee({
          payment_id: "pi_5",
          remaining_balance: 1,
        }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    expect(penny).toContain("Balance outstanding");
  });

  test("a refresh control offers the refresh form or names the failure", () => {
    const refreshable = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_7" }),
        refresh: {
          kind: "available",
          url: "/admin/attendees/1/refresh-payment",
        },
        showBalanceLink: false,
      }),
    );
    expect(refreshable).toContain('class="inline"');
    expect(refreshable).toContain(
      'action="/admin/attendees/1/refresh-payment"',
    );
    expect(refreshable).toContain("Refresh payment status");

    const failed = String(
      PaymentDetails({
        attendee: testAttendee(),
        refresh: { kind: "unavailable", message: "Provider is unreachable." },
        showBalanceLink: false,
      }),
    );
    expect(failed).toContain("Provider is unreachable.");
    expect(failed).not.toContain("refresh-payment");
  });
});

describe("attendee refund confirmation pages", () => {
  beforeEach(setupAdminPageTest);

  test("the single-attendee refund page names the person and the warning", () => {
    const html = adminRefundAttendeePage(
      // 0x1A parses as decimal 0 under radix 10: an unparsable-looking price
      // must not show as paid, which a zero radix would read as 26.
      { attendee: testAttendee({ payment_id: "pi_2", price_paid: "0x1A" }) },
      OWNER_SESSION,
    );
    expect(html).toContain("Refund Attendee: John Doe");
    expect(html).toContain('action="/admin/attendees/1/refund"');
    expect(html).toContain(
      "This will issue a full refund for this attendee's payment",
    );
    expect(html).toContain("<strong>Warning:</strong>");
    expect(html).not.toContain("<strong>Amount Paid:</strong>");
    // The refund confirm sits under the Home nav, not a section's.
    expect(html).toContain('<a class="active" href="/admin/"');
  });

  test("the blocked refund page keeps the facts but sends nothing", () => {
    const blocked = adminBlockedRefundAttendeePage(
      { attendee: testAttendee({ payment_id: "pi_3", price_paid: "700" }) },
      OWNER_SESSION,
    );
    expect(blocked).toContain("Refund Attendee: John Doe");
    expect(blocked).toContain("<strong>Amount Paid:</strong> £7");
    expect(blocked).toContain("Attendee Details");
    // A disabled confirm page sends nothing: no form and no submit control.
    expect(blocked).not.toContain("<form");
    expect(blocked).not.toContain('type="submit"');
  });

  test("the payment-review page carries its identity and confirm word", () => {
    const html = adminPaymentReviewPage(
      {
        attendee: testAttendee({ payment_id: "pi_4", price_paid: "800" }),
        reviewIdentity: "case-88",
      },
      OWNER_SESSION,
    );
    expect(html).toContain('action="/admin/attendees/1/payment-review"');
    expect(html).toContain("review_identity");
    expect(html).toContain("case-88");
    expect(html).toContain("type their name");
    // The review page's details stay payment-blind: no amount line, even
    // though this attendee paid.
    expect(html).not.toContain("<strong>Amount Paid:</strong>");
  });

  test("the resend-notification page is safe, paid-aware, and explains itself", () => {
    const html = adminResendNotificationPage(
      { attendee: testAttendee({ payment_id: "pi_6", price_paid: "1" }) },
      OWNER_SESSION,
    );
    expect(html).toContain("Re-send Notification: John Doe");
    expect(html).toContain('action="/admin/attendees/1/resend-notification"');
    expect(html).toContain(
      "This will re-send the registration notification for this attendee.",
    );
    expect(html).toContain("<strong>Note:</strong>");
    // One minor unit still shows as paid on the details block.
    expect(html).toContain("<strong>Amount Paid:</strong>");
    // Re-sending is not a destructive action: no danger styling anywhere.
    expect(html).not.toContain('class="danger"');
  });

  test("the refund-all page warns per the count and the blocker's reason", () => {
    const listing = testListingWithCount({ id: 5, name: "Camp" });
    const blocked = adminRefundAllAttendeesPage(
      listing,
      {
        count: 3,
        flash: "Try again later.",
        kind: "unavailable",
        reason: "Two attendees still have payments in flight.",
      },
      OWNER_SESSION,
    );
    expect(blocked).toContain("Refund All: Camp");
    expect(blocked).toContain(
      "This will issue a full refund for all 3 attendee(s)",
    );
    expect(blocked).toContain("Two attendees still have payments in flight.");
    expect(blocked).toContain("Try again later.");

    const ready = adminRefundAllAttendeesPage(
      listing,
      { count: 2, flash: undefined, kind: "available" },
      OWNER_SESSION,
    );
    expect(ready).toContain("all 2 attendee(s)");
    expect(ready).toContain('action="/admin/listing/5/refund-all"');
    expect(ready).toContain('<a class="active" href="/admin/"');
    expect(ready).not.toContain("payments in flight");
    expect(ready).not.toContain("Try again later.");
  });
});
