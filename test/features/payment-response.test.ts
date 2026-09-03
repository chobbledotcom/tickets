import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  checkoutResponse,
  paymentErrorResponse,
} from "#routes/payment-response.ts";
import { detectIframeMode } from "#shared/iframe.ts";

describe("paymentErrorResponse", () => {
  test("renders the message on a 400 by default", async () => {
    const response = paymentErrorResponse("Something went wrong");

    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("Something went wrong");
    expect(page).not.toContain("Staff diagnostics");
  });

  test("honours the given status", () => {
    expect(paymentErrorResponse("Busy", 503).status).toBe(503);
  });

  test("renders the diagnostics panel when handed one", async () => {
    const response = paymentErrorResponse("Payment failed", 400, {
      reasons: ["The card step was never finished."],
      rows: [{ label: "Session id", value: "cs_panel" }],
    });

    const page = await response.text();
    expect(page).toContain("Staff diagnostics");
    expect(page).toContain("Session id");
    expect(page).toContain("cs_panel");
    expect(page).toContain("The card step was never finished.");
  });
});

describe("checkoutResponse", () => {
  afterEach(() => {
    detectIframeMode(new URL("https://example.com/"));
  });

  test("redirects straight to the checkout outside an iframe", () => {
    const response = checkoutResponse("https://checkout.example.com/pay");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://checkout.example.com/pay",
    );
  });

  test("renders the popup page inside an iframe", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));

    const response = checkoutResponse("https://checkout.example.com/pay");

    expect(response.status).toBe(200);
  });
});
