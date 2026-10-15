import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";

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
    says(html, '<div class="prose"><h3>Payment Details</h3>');
    says(html, "<strong>Payment ID:</strong> pi_123");
    says(html, "<strong>Amount Paid:</strong> £15");
    says(html, "<strong>Refund Status:</strong> Not refunded");
    // A fully paid attendee shows no outstanding balance line.
    assert(!html.includes("Balance outstanding"));
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
    says(html, "Payment ID");
    assert(!html.includes("Amount Paid"));
    // One minor unit still counts as paid.
    const penny = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_one", price_paid: "1" }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    says(penny, "Amount Paid:");
  });

  test("the refunded state shows the refund badge", () => {
    const html = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_9", refunded: true }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    says(html, "Refunded");
    assert(!html.includes("Not refunded"));
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
    says(linked, "Balance outstanding:</strong> £4 — <a href=");
    says(
      linked,
      '<a href="/admin/attendees/1/ledger">View money changes and payment link</a>',
    );

    const unlinked = String(
      PaymentDetails({
        attendee: owed,
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    says(unlinked, "Balance outstanding");
    assert(!unlinked.includes("/ledger"));

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
    says(penny, "Balance outstanding");
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
    says(refreshable, 'class="inline"');
    says(refreshable, 'action="/admin/attendees/1/refresh-payment"');
    says(refreshable, "Refresh payment status");

    const failed = String(
      PaymentDetails({
        attendee: testAttendee(),
        refresh: { kind: "unavailable", message: "Provider is unreachable." },
        showBalanceLink: false,
      }),
    );
    says(failed, "Provider is unreachable.");
    assert(!failed.includes("refresh-payment"));
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
    says(html, "Refund Attendee: John Doe");
    says(html, 'action="/admin/attendees/1/refund"');
    says(html, "This will issue a full refund for this attendee's payment");
    says(html, "<strong>Warning:</strong>");
    assert(!html.includes("<strong>Amount Paid:</strong>"));
    // The refund confirm sits under the Home nav, not a section's.
    says(html, '<a class="active" href="/admin/"');
  });

  test("the blocked refund page keeps the facts but sends nothing", () => {
    const blocked = adminBlockedRefundAttendeePage(
      { attendee: testAttendee({ payment_id: "pi_3", price_paid: "700" }) },
      OWNER_SESSION,
    );
    says(blocked, "Refund Attendee: John Doe");
    says(blocked, "<strong>Amount Paid:</strong> £7");
    says(blocked, "Attendee Details");
    // A disabled confirm page sends nothing: no form and no submit control.
    assert(!blocked.includes("<form"));
    assert(!blocked.includes('type="submit"'));
  });

  test("the payment-review page carries its identity and confirm word", () => {
    const html = adminPaymentReviewPage(
      {
        attendee: testAttendee({ payment_id: "pi_4", price_paid: "800" }),
        reviewIdentity: "case-88",
      },
      OWNER_SESSION,
    );
    says(html, 'action="/admin/attendees/1/payment-review"');
    says(html, "review_identity");
    says(html, "case-88");
    says(html, "type their name");
    // The review page's details stay payment-blind: no amount line, even
    // though this attendee paid.
    assert(!html.includes("<strong>Amount Paid:</strong>"));
  });

  test("the resend-notification page is safe, paid-aware, and explains itself", () => {
    const html = adminResendNotificationPage(
      { attendee: testAttendee({ payment_id: "pi_6", price_paid: "1" }) },
      OWNER_SESSION,
    );
    says(html, "Re-send Notification: John Doe");
    says(html, 'action="/admin/attendees/1/resend-notification"');
    says(
      html,
      "This will re-send the registration notification for this attendee.",
    );
    says(html, "<strong>Note:</strong>");
    // One minor unit still shows as paid on the details block.
    says(html, "<strong>Amount Paid:</strong>");
    // Re-sending is not a destructive action: no danger styling anywhere.
    assert(!html.includes('class="danger"'));
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
    says(blocked, "Refund All: Camp");
    says(blocked, "This will issue a full refund for all 3 attendee(s)");
    says(blocked, "Two attendees still have payments in flight.");
    says(blocked, "Try again later.");

    const ready = adminRefundAllAttendeesPage(
      listing,
      { count: 2, flash: undefined, kind: "available" },
      OWNER_SESSION,
    );
    says(ready, "all 2 attendee(s)");
    says(ready, 'action="/admin/listing/5/refund-all"');
    says(ready, '<a class="active" href="/admin/"');
    assert(!ready.includes("payments in flight"));
    assert(!ready.includes("Try again later."));
  });
});
