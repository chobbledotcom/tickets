import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentWebhookUrl } from "#shared/payment-webhook-address.ts";

describe("paymentWebhookUrl", () => {
  test("puts the payment callback path under https on the domain", () => {
    expect(paymentWebhookUrl("tickets.example.com")).toBe(
      "https://tickets.example.com/payment/webhook",
    );
  });
});
