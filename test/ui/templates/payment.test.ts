import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { detectIframeMode } from "#shared/request-context.ts";
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
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { testAttendee, testListing } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

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
    expectIncludesAll(html, [
      "Complete Your Payment",
      "John Doe",
      "john@example.com",
      "£10.00",
    ]);
  });

  test("includes checkout URL", () => {
    const html = paymentPage(
      listing,
      attendee,
      "https://checkout.stripe.com/session",
      "£10.00",
    );
    expectIncludesAll(html, [
      "https://checkout.stripe.com/session",
      'class="btn"',
      "Pay Now",
    ]);
  });

  test("escapes user data", () => {
    const evilAttendee = testAttendee({ name: "<script>evil()</script>" });
    const html = paymentPage(
      listing,
      evilAttendee,
      "https://checkout.stripe.com/session",
      "£10.00",
    );
    assertStringIncludes(html, "&lt;script&gt;");
  });
});

describe("successPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders order success message when paid", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: null,
    });
    expectIncludesAll(html, [
      "Thank you for your order",
      "https://example.com/thanks",
      'class="prose"',
    ]);
  });

  test("renders order success message when not paid", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    expectIncludesAll(html, ["Order Successful", "Thank you for your order"]);
  });

  test("includes meta refresh redirect", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: null,
    });
    expectIncludesAll(html, [
      'http-equiv="refresh"',
      "3;url=https://example.com/thanks",
    ]);
  });

  test("includes data-payment-result attribute for popup postMessage", () => {
    const html = successPage({ paid: true, ticketUrl: null });
    assertStringIncludes(html, 'data-payment-result="success"');
  });

  test("excludes data-payment-result attribute when not paid", () => {
    const html = successPage({ ticketUrl: null });
    assert(!html.includes("data-payment-result"));
  });

  test("renders without redirect when thankYouUrl is empty", () => {
    const html = successPage({ paid: true, ticketUrl: null });
    assert(!html.includes('http-equiv="refresh"'));
    assert(!html.includes("redirected"));
  });

  test("renders ticket link with plural text for multiple tickets", () => {
    const html = successPage({ paid: true, ticketUrl: "/t/abc123+def456" });
    expectIncludesAll(html, [
      'href="/t/abc123+def456"',
      'target="_blank"',
      "View your tickets",
    ]);
  });

  test("renders ticket link with singular text for single ticket", () => {
    const html = successPage({ paid: true, ticketUrl: "/t/abc123" });
    expectIncludesAll(html, ['href="/t/abc123"', "View your ticket"]);
    // The plural link text contains the singular as a prefix, so the exact
    // plural words are what proves this one-token link reads as singular.
    assert(!html.includes("View your tickets"));
  });

  test("renders both ticket link and redirect when both provided", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: "/t/abc123",
    });
    expectIncludesAll(html, [
      'href="/t/abc123"',
      "View your ticket",
      "https://example.com/thanks",
      'http-equiv="refresh"',
    ]);
  });

  test("does not render ticket link when ticketUrl is null", () => {
    const html = successPage({ paid: true, ticketUrl: null });
    assert(!html.includes("view your ticket"));
  });

  test("includes iframe-resizer child script in iframe mode", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      const html = successPage({ ticketUrl: "/t/abc123" });
      expectIncludesAll(html, ["iframe-resizer-child.js", 'class="iframe"']);
    });
  });

  test("excludes iframe-resizer child script when not in iframe mode", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    assert(!html.includes("iframe-resizer-child.js"));
    assert(!html.includes('class="iframe"'));
  });

  test("includes scroll-into-view marker in iframe mode", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      const html = successPage({ ticketUrl: "/t/abc123" });
      assertStringIncludes(html, "data-scroll-into-view");
    });
  });

  test("excludes scroll-into-view marker when not in iframe mode", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    assert(!html.includes("data-scroll-into-view"));
  });

  test("shows email notice when fromEmail is provided", () => {
    const html = successPage({
      fromEmail: "tickets@example.com",
      paid: true,
      ticketUrl: "/t/abc123",
    });
    expectIncludesAll(html, ["tickets@example.com", "Junk/Spam"]);
  });

  test("does not show email notice when fromEmail is empty", () => {
    const html = successPage({ paid: true, ticketUrl: "/t/abc123" });
    assert(!html.includes("Junk/Spam"));
  });
  test("shows email notice for reservation when fromEmail is provided", () => {
    const html = successPage({
      fromEmail: "tickets@example.com",
      ticketUrl: "/t/abc123",
    });
    expectIncludesAll(html, ["tickets@example.com", "Junk/Spam"]);
  });

  test("does not show email notice for reservation when fromEmail is empty", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    assert(!html.includes("Junk/Spam"));
  });
});

describe("paymentCancelPage", () => {
  beforeAll(setupAdminPageTest);

  const listing = testListing({ unit_price: 1000 });

  test("renders cancel message", () => {
    const html = paymentCancelPage(listing, "/ticket/ab12c");
    expectIncludesAll(html, [
      "Payment Cancelled",
      "/ticket/ab12c",
      "Try again",
      'class="prose"',
      'class="btn outline"',
    ]);
  });

  test("includes data-payment-result attribute for popup postMessage", () => {
    const html = paymentCancelPage(listing, "/ticket/ab12c");
    assertStringIncludes(html, 'data-payment-result="cancel"');
  });

  test("shows a return-home link (no retry) when the listing has no standalone page", () => {
    // A null URL means the listing has no standalone page.
    const html = paymentCancelPage(listing, null);
    expectIncludesAll(html, [
      "Payment Cancelled",
      "Return home",
      'href="/"',
      'class="btn outline"',
    ]);
    assert(!html.includes("Try again"));
  });
});

describe("checkoutPopupPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders checkout URL in data attribute", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    assertStringIncludes(
      html,
      'data-checkout-popup="https://checkout.stripe.com/session123"',
    );
  });

  test("renders the iframe confirmation URL for the parent navigation", async () => {
    const html = await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      return checkoutPopupPage("https://checkout.stripe.com/session123");
    });
    assertStringIncludes(
      html,
      'data-success-href="/ticket/reserved?iframe=true"',
    );
  });

  test("renders Pay Now link with target _blank", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    // The waiting hint's new-tab link also carries target="_blank", so the
    // popup anchor is matched through its own data-open-checkout attribute.
    expect(html).toMatch(/data-open-checkout[^>]*target="_blank"/);
    expectIncludesAll(html, ['class="btn"', "Pay Now"]);
  });

  test("includes waiting element for popup state", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    assertStringIncludes(html, "data-checkout-waiting");
  });

  test("uses iframe body class", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    assertStringIncludes(html, 'class="iframe"');
  });

  test("includes iframe-resizer child script", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    assertStringIncludes(html, "iframe-resizer-child.js");
  });

  test("escapes checkout URL", () => {
    const html = checkoutPopupPage('https://evil.com/"onload="alert(1)');
    assertStringIncludes(html, "&quot;");
    assert(!html.includes('"onload="'));
  });

  test("includes scroll-into-view marker for parent scroll", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    assertStringIncludes(html, "data-scroll-into-view");
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
    expectIncludesAll(html, [
      "Payment not confirmed yet",
      "We have not received your payment yet",
      "your ticket will be sent to you by email",
      "Check again",
      'href="/payment/success?session_id=cs_1"',
      'class="prose"',
      'class="btn outline"',
    ]);
  });

  test("does not tell a popup that the payment was cancelled", () => {
    const html = page("/payment/success?session_id=cs_1&wait=1");
    assert(!html.includes("data-payment-result"));
  });

  test("reloads itself on a timer while the window is open", () => {
    const html = page("/payment/success?session_id=cs_1&wait=3");
    expectIncludesAll(html, [
      'http-equiv="refresh"',
      "30;url=/payment/success?session_id=cs_1",
      "This page will keep checking for you.",
    ]);
  });

  test("stops reloading at the end of the window", () => {
    const html = page(null);
    assert(!html.includes('http-equiv="refresh"'));
    assert(!html.includes("This page will keep checking for you."));
    assertStringIncludes(html, "Check again");
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
    expectIncludesAll(html, [
      'class="staff-diagnostics"',
      "Known reasons a payment can sit unconfirmed:",
      "Payment status",
      "unpaid",
    ]);
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
    expectIncludesAll(html, [
      "Payment Error",
      "Payment verification failed",
      'class="error"',
    ]);
  });

  test("escapes error message", () => {
    const html = paymentErrorPage("<script>evil()</script>");
    assertStringIncludes(html, "&lt;script&gt;");
  });

  test("includes home link", () => {
    const html = paymentErrorPage("Error");
    assertStringIncludes(html, 'href="/"');
  });

  test("renders the staff diagnostics panel for an owner", () => {
    const html = paymentErrorPage("Payment verification failed", {
      reasons: [
        "The card step was never finished. For example, the 3-D Secure window was closed.",
      ],
      rows: [{ label: "Session id", value: "cs_test_123" }],
    });
    expectIncludesAll(html, [
      'class="staff-diagnostics"',
      "Staff diagnostics",
      "Session id",
      "cs_test_123",
      "Known reasons a payment can sit unconfirmed:",
      "The card step was never finished",
    ]);
  });
});
