import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import {
  checkoutPopupPage,
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  successPage,
} from "#templates/payment.tsx";
import { setupTestEncryptionKey, testAttendee, testEvent } from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

afterEach(() => {
  detectIframeMode("https://example.com/");
});

describe("paymentPage", () => {
  const event = testEvent({ unit_price: 1000 });
  const attendee = testAttendee();

  test("renders payment details", () => {
    const html = paymentPage(
      event,
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
      event,
      attendee,
      "https://checkout.stripe.com/session",
      "£10.00",
    );
    expect(html).toContain("https://checkout.stripe.com/session");
    expect(html).toContain("Pay Now");
  });

  test("escapes user data", () => {
    const evilAttendee = testAttendee({ name: "<script>evil()</script>" });
    const html = paymentPage(
      event,
      evilAttendee,
      "https://checkout.stripe.com/session",
      "£10.00",
    );
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("successPage", () => {
  test("renders order success message when paid", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: null,
    });
    expect(html).toContain("Thank you for your order");
    expect(html).toContain("https://example.com/thanks");
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
    expect(html).toContain("Click here to view your ticket");
  });

  test("renders ticket link with singular text for single ticket", () => {
    const html = successPage({ paid: true, ticketUrl: "/t/abc123" });
    expect(html).toContain('href="/t/abc123"');
    expect(html).toContain("Click here to view your ticket");
  });

  test("renders both ticket link and redirect when both provided", () => {
    const html = successPage({
      paid: true,
      thankYouUrl: "https://example.com/thanks",
      ticketUrl: "/t/abc123",
    });
    expect(html).toContain('href="/t/abc123"');
    expect(html).toContain("Click here to view your ticket");
    expect(html).toContain("https://example.com/thanks");
    expect(html).toContain('http-equiv="refresh"');
  });

  test("does not render ticket link when ticketUrl is null", () => {
    const html = successPage({ paid: true, ticketUrl: null });
    expect(html).not.toContain("view your ticket");
  });

  test("includes iframe-resizer child script in iframe mode", () => {
    detectIframeMode("https://example.com/?iframe=true");
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).toContain("iframe-resizer-child.js");
    expect(html).toContain('class="iframe"');
    detectIframeMode("https://example.com/");
  });

  test("excludes iframe-resizer child script when not in iframe mode", () => {
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).not.toContain("iframe-resizer-child.js");
    expect(html).not.toContain('class="iframe"');
  });

  test("includes scroll-into-view marker in iframe mode", () => {
    detectIframeMode("https://example.com/?iframe=true");
    const html = successPage({ ticketUrl: "/t/abc123" });
    expect(html).toContain("data-scroll-into-view");
    detectIframeMode("https://example.com/");
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

describe("paymentCancelPage", () => {
  const event = testEvent({ unit_price: 1000 });

  test("renders cancel message", () => {
    const html = paymentCancelPage(event, "/ticket/ab12c");
    expect(html).toContain("Payment Cancelled");
    expect(html).toContain("/ticket/ab12c");
    expect(html).toContain("Try again");
  });

  test("includes data-payment-result attribute for popup postMessage", () => {
    const html = paymentCancelPage(event, "/ticket/ab12c");
    expect(html).toContain('data-payment-result="cancel"');
  });
});

describe("checkoutPopupPage", () => {
  test("renders checkout URL in data attribute", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    expect(html).toContain(
      'data-checkout-popup="https://checkout.stripe.com/session123"',
    );
  });

  test("renders Pay Now link with target _blank", () => {
    const html = checkoutPopupPage("https://checkout.stripe.com/session123");
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Pay Now");
    expect(html).toContain("data-open-checkout");
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

describe("paymentErrorPage", () => {
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
});
