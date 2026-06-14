import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { paymentDashboardUrl } from "#shared/payment-dashboard.ts";

describe("paymentDashboardUrl", () => {
  afterEach(() => {
    settings.clearTestOverrides();
  });

  test("returns null when payment id is empty", () => {
    settings.setForTest({ payment_provider: "stripe" });
    expect(paymentDashboardUrl("")).toBe(null);
  });

  test("returns null when no provider is configured", () => {
    settings.setForTest({ payment_provider: null });
    expect(paymentDashboardUrl("pi_123")).toBe(null);
  });

  test("links to the live Stripe dashboard for a live key", () => {
    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "sk_live_abc",
    });
    expect(paymentDashboardUrl("pi_123")).toBe(
      "https://dashboard.stripe.com/payments/pi_123",
    );
  });

  test("links to the test Stripe dashboard for a test key", () => {
    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "sk_test_abc",
    });
    expect(paymentDashboardUrl("pi_123")).toBe(
      "https://dashboard.stripe.com/test/payments/pi_123",
    );
  });

  test("links to the production Square dashboard", () => {
    settings.setForTest({
      payment_provider: "square",
      square_sandbox: false,
    });
    expect(paymentDashboardUrl("pay_1")).toBe(
      "https://squareup.com/dashboard/sales/transactions/pay_1",
    );
  });

  test("links to the sandbox Square dashboard", () => {
    settings.setForTest({
      payment_provider: "square",
      square_sandbox: true,
    });
    expect(paymentDashboardUrl("pay_1")).toBe(
      "https://squareupsandbox.com/dashboard/sales/transactions/pay_1",
    );
  });

  test("links to the SumUp dashboard", () => {
    settings.setForTest({ payment_provider: "sumup" });
    expect(paymentDashboardUrl("tx_1")).toBe(
      "https://me.sumup.com/sales/transactions/tx_1",
    );
  });

  test("encodes the payment id", () => {
    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "sk_live_abc",
    });
    expect(paymentDashboardUrl("pi/with space")).toBe(
      "https://dashboard.stripe.com/payments/pi%2Fwith%20space",
    );
  });
});
