import { assert, assertStringIncludes } from "@std/assert";
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
    assertStringIncludes(html, '<div class="prose"><h3>Payment Details</h3>');
    assertStringIncludes(html, "<strong>Payment ID:</strong> pi_123");
    assertStringIncludes(html, "<strong>Amount Paid:</strong> £15");
    assertStringIncludes(html, "<strong>Refund Status:</strong> Not refunded");
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
    assertStringIncludes(html, "Payment ID");
    assert(!html.includes("Amount Paid"));
    // One minor unit still counts as paid.
    const penny = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_one", price_paid: "1" }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    assertStringIncludes(penny, "Amount Paid:");
  });

  test("the refunded state shows the refund badge", () => {
    const html = String(
      PaymentDetails({
        attendee: testAttendee({ payment_id: "pi_9", refunded: true }),
        refresh: { kind: "none" },
        showBalanceLink: false,
      }),
    );
    assertStringIncludes(html, "Refunded");
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
    assertStringIncludes(linked, "Balance outstanding:</strong> £4 — <a href=");
    assertStringIncludes(
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
    assertStringIncludes(unlinked, "Balance outstanding");
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
    assertStringIncludes(penny, "Balance outstanding");
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
    assertStringIncludes(refreshable, 'class="inline"');
    assertStringIncludes(
      refreshable,
      'action="/admin/attendees/1/refresh-payment"',
    );
    assertStringIncludes(refreshable, "Refresh payment status");

    const failed = String(
      PaymentDetails({
        attendee: testAttendee(),
        refresh: { kind: "unavailable", message: "Provider is unreachable." },
        showBalanceLink: false,
      }),
    );
    assertStringIncludes(failed, "Provider is unreachable.");
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
    assertStringIncludes(html, "Refund Attendee: John Doe");
    assertStringIncludes(html, 'action="/admin/attendees/1/refund"');
    assertStringIncludes(
      html,
      "This will issue a full refund for this attendee's payment",
    );
    assertStringIncludes(html, "<strong>Warning:</strong>");
    assert(!html.includes("<strong>Amount Paid:</strong>"));
    // The refund confirm sits under the Home nav, not a section's.
    assertStringIncludes(html, '<a class="active" href="/admin/"');
  });

  test("the blocked refund page keeps the facts but sends nothing", () => {
    const blocked = adminBlockedRefundAttendeePage(
      { attendee: testAttendee({ payment_id: "pi_3", price_paid: "700" }) },
      OWNER_SESSION,
    );
    assertStringIncludes(blocked, "Refund Attendee: John Doe");
    assertStringIncludes(blocked, "<strong>Amount Paid:</strong> £7");
    assertStringIncludes(blocked, "Attendee Details");
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
    assertStringIncludes(html, 'action="/admin/attendees/1/payment-review"');
    assertStringIncludes(html, "review_identity");
    assertStringIncludes(html, "case-88");
    assertStringIncludes(html, "type their name");
    // The review page's details stay payment-blind: no amount line, even
    // though this attendee paid.
    assert(!html.includes("<strong>Amount Paid:</strong>"));
  });

  test("the resend-notification page is safe, paid-aware, and explains itself", () => {
    const html = adminResendNotificationPage(
      {
        attendee: testAttendee({ payment_id: "pi_6", price_paid: "1" }),
        // No webhook exists, so the page carries the email choice hidden.
        hasWebhook: false,
      },
      OWNER_SESSION,
    );
    assertStringIncludes(html, "Re-send Notification: John Doe");
    assertStringIncludes(
      html,
      'action="/admin/attendees/1/resend-notification"',
    );
    assertStringIncludes(
      html,
      "This will re-send the registration notification for this attendee.",
    );
    assertStringIncludes(html, "<strong>Note:</strong>");
    // One minor unit still shows as paid on the details block.
    assertStringIncludes(html, "<strong>Amount Paid:</strong>");
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
    assertStringIncludes(blocked, "Refund All: Camp");
    assertStringIncludes(
      blocked,
      "This will issue a full refund for all 3 attendee(s)",
    );
    assertStringIncludes(
      blocked,
      "Two attendees still have payments in flight.",
    );
    assertStringIncludes(blocked, "Try again later.");

    const ready = adminRefundAllAttendeesPage(
      listing,
      { count: 2, flash: undefined, kind: "available" },
      OWNER_SESSION,
    );
    assertStringIncludes(ready, "all 2 attendee(s)");
    assertStringIncludes(ready, 'action="/admin/listing/5/refund-all"');
    assertStringIncludes(ready, '<a class="active" href="/admin/"');
    assert(!ready.includes("payments in flight"));
    assert(!ready.includes("Try again later."));
  });

  test("the confirmation pages carry the owed-send pills beside the name", () => {
    // AttendeeDetails serves the refund, payment-review and re-send
    // confirmations, so the pills render there too. A person still owed a
    // send shows it at the decision point; a settled person never does.
    const flagged = testAttendee({
      email_owed: 1,
      email_pending: 1,
      webhooks_pending: 1,
    });
    const flaggedPages = [
      adminRefundAttendeePage({ attendee: flagged }, OWNER_SESSION),
      adminPaymentReviewPage(
        { attendee: flagged, reviewIdentity: "case-9" },
        OWNER_SESSION,
      ),
      adminResendNotificationPage(
        { attendee: flagged, hasWebhook: true },
        OWNER_SESSION,
      ),
    ];
    for (const html of flaggedPages) {
      assertStringIncludes(html, "Email not sent");
      assertStringIncludes(html, "Webhooks not sent");
    }

    const settledPages = [
      adminRefundAttendeePage({ attendee: testAttendee() }, OWNER_SESSION),
      adminPaymentReviewPage(
        { attendee: testAttendee(), reviewIdentity: "case-9" },
        OWNER_SESSION,
      ),
      adminResendNotificationPage(
        { attendee: testAttendee(), hasWebhook: true },
        OWNER_SESSION,
      ),
    ];
    for (const html of settledPages) {
      assert(!html.includes("Email not sent"));
      assert(!html.includes("Webhooks not sent"));
    }
  });
});
