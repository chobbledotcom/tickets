import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { detectIframeMode } from "#shared/iframe.ts";
import {
  checkoutPopupPage,
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  paymentWaitingPage,
  successPage,
  WAITING_PAGE_RELOAD_LIMIT,
  waitingPageStillReloads,
} from "#templates/payment.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testAttendee, testListing } from "#test-utils/factories.ts";

describe("paymentPage", () => {
  beforeAll(setupAdminPageTest);

  const listing = testListing({ unit_price: 1000 });
  const attendee = testAttendee();

  test("renders payment details", () => {
    const html = paymentPage(
      listing,
      attendee,
      "https://checkout.stripe.com/session",
      "£10.00",
    );
    expect(html).toContain("Complete Your Payment");
    expect(html).toContain("John Doe");
    expect(html).toContain("john@example.com");
    expect(html).toContain("£10.00");
  });

  test("includes checkout URL", () => {
    const html = paymentPage(
      listing,
      attendee,
      "https://checkout.stripe.com/session",
      "£10.00",
    );
    expect(html).toContain("https://checkout.stripe.com/session");
    expect(html).toContain('class="btn"');
    expect(html).toContain("Pay Now");
  });

  test("escapes user data", () => {
    const evilAttendee = testAttendee({ name: "<script>evil()</script>" });
    const html = paymentPage(
      listing,
      evilAttendee,
      "https://checkout.stripe.com/session",
      "£10.00",
    );
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("successPage", () => {
  beforeAll(setupAdminPageTest);
  afterEach(() => {
    detectIframeMode(new URL("https://example.com/"));
  });

  test("renders order success message when paid", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: null,
    });
    expect(html).toContain("Thank you for your order");
    expect(html).toContain("https://example.com/thanks");
    expect(html).toContain('class="prose"');
  });

  test("renders order success message when not paid", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).toContain("Order Successful");
    expect(html).toContain("Thank you for your order");
  });

  test("includes meta refresh redirect", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: null,
    });
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("3;url=https://example.com/thanks");
  });

  test("includes data-payment-result attribute for popup postMessage", () => {
    const html = successPage({ paid: true, ticketUrl: null });
    expect(html).toContain('data-payment-result="success"');
  });

  test("excludes data-payment-result attribute when not paid", () => {
    const html = successPage({ ticketUrl: null });
    expect(html).not.toContain("data-payment-result");
  });

  test("renders without redirect when thankYouUrl is empty", () => {
    const html = successPage({ paid: true, ticketUrl: null });
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("redirected");
  });

  test("renders ticket link with plural text for multiple tickets", () => {
    const html = successPage({ paid: true, ticketUrl: "/t/abc123+def456" });
    expect(html).toContain('href="/t/abc123+def456"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("View your tickets");
  });

  test("renders ticket link with singular text for single ticket", () => {
    const html = successPage({ paid: true, ticketUrl: "/t/abc123" });
    expect(html).toContain('href="/t/abc123"');
    expect(html).toContain("View your ticket");
    // The plural link text contains the singular as a prefix, so the exact
    // plural words are what proves this one-token link reads as singular.
    expect(html).not.toContain("View your tickets");
  });

  test("renders both ticket link and redirect when both provided", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: "/t/abc123",
    });
    expect(html).toContain('href="/t/abc123"');
    expect(html).toContain("View your ticket");
    expect(html).toContain("https://example.com/thanks");
    expect(html).toContain('http-equiv="refresh"');
  });

  test("does not render ticket link when ticketUrl is null", () => {
    const html = successPage({ paid: true, ticketUrl: null });
    expect(html).not.toContain("view your ticket");
  });

  test("includes iframe-resizer child script in iframe mode", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).toContain("iframe-resizer-child.js");
    expect(html).toContain('class="iframe"');
    detectIframeMode(new URL("https://example.com/"));
  });

  test("excludes iframe-resizer child script when not in iframe mode", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).not.toContain("iframe-resizer-child.js");
    expect(html).not.toContain('class="iframe"');
  });

  test("includes scroll-into-view marker in iframe mode", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).toContain("data-scroll-into-view");
    detectIframeMode(new URL("https://example.com/"));
  });

  test("excludes scroll-into-view marker when not in iframe mode", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).not.toContain("data-scroll-into-view");
  });

  test("shows email notice when fromEmail is provided", () => {
    const html = successPage({
      fromEmail: "tickets@example.com",
      paid: true,
      ticketUrl: "/t/abc123",
    });
    expect(html).toContain("tickets@example.com");
    expect(html).toContain("Junk/Spam");
  });

  test("does not show email notice when fromEmail is empty", () => {
    const html = successPage({ paid: true, ticketUrl: "/t/abc123" });
    expect(html).not.toContain("Junk/Spam");
  });
  test("shows email notice for reservation when fromEmail is provided", () => {
    const html = successPage({
      fromEmail: "tickets@example.com",
      ticketUrl: "/t/abc123",
    });
    expect(html).toContain("tickets@example.com");
    expect(html).toContain("Junk/Spam");
  });

  test("does not show email notice for reservation when fromEmail is empty", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).not.toContain("Junk/Spam");
  });
});

describe("paymentCancelPage", () => {
  beforeAll(setupAdminPageTest);

  const listing = testListing({ unit_price: 1000 });

  test("renders cancel message", () => {
    const html = paymentCancelPage(listing, "/ticket/ab12c");
    expect(html).toContain("Payment Cancelled");
    expect(html).toContain("/ticket/ab12c");
    expect(html).toContain("Try again");
    expect(html).toContain('class="prose"');
    expect(html).toContain('class="btn outline"');
  });

  test("includes data-payment-result attribute for popup postMessage", () => {
    const html = paymentCancelPage(listing, "/ticket/ab12c");
    expect(html).toContain('data-payment-result="cancel"');
  });

  test("shows a return-home link (no retry) when the listing has no standalone page", () => {
    // A null ticket URL means the listing lost its own page mid-checkout (a
    // now-non-standalone child or hidden package member), so a /ticket retry
    // would 404 — the page offers a way home instead of a dead retry link.
    const html = paymentCancelPage(listing, null);
    expect(html).toContain("Payment Cancelled");
    expect(html).toContain("Return home");
    expect(html).toContain('href="/"');
    expect(html).toContain('class="btn outline"');
    expect(html).not.toContain("Try again");
  });
});

describe("checkoutPopupPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders checkout URL in data attribute", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    expect(html).toContain(
      'data-checkout-popup="https://checkout.stripe.com/session123"',
    );
  });

  test("renders Pay Now link with target _blank", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    // The waiting hint's new-tab link also carries target="_blank", so the
    // popup anchor is matched through its own data-open-checkout attribute.
    expect(html).toMatch(/data-open-checkout[^>]*target="_blank"/);
    expect(html).toContain('class="btn"');
    expect(html).toContain("Pay Now");
  });

  test("includes waiting element for popup state", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    expect(html).toContain("data-checkout-waiting");
  });

  test("uses iframe body class", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    expect(html).toContain('class="iframe"');
  });

  test("includes iframe-resizer child script", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    expect(html).toContain("iframe-resizer-child.js");
  });

  test("escapes checkout URL", () => {
    const html = checkoutPopupPage('https://evil.com/"onload="alert(1)');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('"onload="');
  });

  test("includes scroll-into-view marker for parent scroll", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    expect(html).toContain("data-scroll-into-view");
  });
});

describe("paymentWaitingPage", () => {
  beforeAll(setupAdminPageTest);

  const page = (refreshUrl: string | null) =>
    paymentWaitingPage({
      checkAgainHref: "/payment/success?session_id=cs_1",
      diagnostics: undefined,
      refreshUrl,
    });

  test("renders the waiting copy and the check-again link", () => {
    const html = page("/payment/success?session_id=cs_1&wait=1");
    expect(html).toContain("Payment not confirmed yet");
    expect(html).toContain("We have not received your payment yet");
    expect(html).toContain("your ticket will be sent to you by email");
    expect(html).toContain("Check again");
    expect(html).toContain('href="/payment/success?session_id=cs_1"');
    expect(html).toContain('class="prose"');
    expect(html).toContain('class="btn outline"');
  });

  test("does not tell a popup that the payment was cancelled", () => {
    const html = page("/payment/success?session_id=cs_1&wait=1");
    expect(html).not.toContain("data-payment-result");
  });

  test("reloads itself on a timer while the window is open", () => {
    const html = page("/payment/success?session_id=cs_1&wait=3");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("30;url=/payment/success?session_id=cs_1");
    expect(html).toContain("This page will keep checking for you.");
  });

  test("stops reloading at the end of the window", () => {
    const html = page(null);
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("This page will keep checking for you.");
    expect(html).toContain("Check again");
  });

  test("renders the staff diagnostics panel for an owner", () => {
    const html = paymentWaitingPage({
      checkAgainHref: "/payment/success?session_id=cs_1",
      diagnostics: {
        reasons: ["The provider has not told us yet."],
        rows: [{ label: "Payment status", value: "unpaid" }],
      },
      refreshUrl: null,
    });
    expect(html).toContain('class="staff-diagnostics"');
    expect(html).toContain("Known reasons a payment can sit unconfirmed:");
    expect(html).toContain("Payment status");
    expect(html).toContain("unpaid");
  });

  test("the reload window closes once the limit is reached", () => {
    expect(WAITING_PAGE_RELOAD_LIMIT).toBe(10);
    const answers = [0, 1, 9, 10, 11, 999].map((reloadsSoFar) => [
      reloadsSoFar,
      waitingPageStillReloads(reloadsSoFar),
    ]);
    expect(answers).toEqual([
      [0, true],
      [1, true],
      [9, true],
      [10, false],
      [11, false],
      [999, false],
    ]);
  });
});

describe("paymentErrorPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders error message", () => {
    const html = paymentErrorPage("Payment verification failed");
    expect(html).toContain("Payment Error");
    expect(html).toContain("Payment verification failed");
    expect(html).toContain('class="error"');
  });

  test("escapes error message", () => {
    const html = paymentErrorPage("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("includes home link", () => {
    const html = paymentErrorPage("Error");
    expect(html).toContain('href="/"');
  });

  test("renders the staff diagnostics panel for an owner", () => {
    const html = paymentErrorPage("Payment verification failed", {
      reasons: [
        "The card step was never finished. For example, the 3-D Secure window was closed.",
      ],
      rows: [{ label: "Session id", value: "cs_test_123" }],
    });
    expect(html).toContain('class="staff-diagnostics"');
    expect(html).toContain("Staff diagnostics");
    expect(html).toContain("Session id");
    expect(html).toContain("cs_test_123");
    expect(html).toContain("Known reasons a payment can sit unconfirmed:");
    expect(html).toContain("The card step was never finished");
  });
});
