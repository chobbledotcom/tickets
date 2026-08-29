import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  squareConnectionAnswer,
  stripeConnectionAnswer,
  sumupConnectionAnswer,
} from "#routes/admin/settings-connection-lines.ts";
import type { SquareConnectionTestResult } from "#shared/square/connection.ts";
import type { StripeConnectionTestResult } from "#shared/stripe/endpoints.ts";
import type { SumupConnectionTestResult } from "#shared/sumup.ts";

const stripeResult = (
  over: Partial<StripeConnectionTestResult>,
): StripeConnectionTestResult => ({
  apiKey: { mode: "test", valid: true },
  ok: false,
  webhooks: [],
  ...over,
});

describe("stripeConnectionAnswer", () => {
  test("names a valid key with its mode", () => {
    const answer = stripeConnectionAnswer(stripeResult({}));
    expect(answer.lines[0]).toBe("API Key: Valid (test mode)");
  });

  test("falls back to an unknown mode when the key carries none", () => {
    const answer = stripeConnectionAnswer(
      stripeResult({ apiKey: { valid: true } }),
    );
    expect(answer.lines[0]).toBe("API Key: Valid (unknown mode)");
  });

  test("names an invalid key, with its reason when there is one", () => {
    const withReason = stripeConnectionAnswer(
      stripeResult({ apiKey: { error: "rate limited", valid: false } }),
    );
    const bare = stripeConnectionAnswer(
      stripeResult({ apiKey: { valid: false } }),
    );
    expect(withReason.lines[0]).toBe("API Key: Invalid - rate limited");
    expect(bare.lines[0]).toBe("API Key: Invalid");
  });

  test("reports a webhook error instead of listing endpoints", () => {
    const answer = stripeConnectionAnswer(
      stripeResult({ webhookError: "key revoked" }),
    );
    expect(answer.lines).toEqual([
      "API Key: Valid (test mode)",
      "Webhooks: Error - key revoked",
    ]);
  });

  test("says so when no webhook endpoint is configured", () => {
    const answer = stripeConnectionAnswer(stripeResult({}));
    expect(answer.lines).toEqual([
      "API Key: Valid (test mode)",
      "Webhooks: None configured",
    ]);
  });

  test("lists each endpoint, marking the one this site created", () => {
    const answer = stripeConnectionAnswer(
      stripeResult({
        ok: true,
        ownEndpointId: "we_ours",
        webhooks: [
          {
            enabledEvents: ["checkout.session.completed"],
            endpointId: "we_ours",
            status: "enabled",
            url: "https://example.com/payment/webhook",
          },
          {
            enabledEvents: ["charge.refunded", "payment_intent.succeeded"],
            endpointId: "we_theirs",
            status: "disabled",
            url: "https://other.example/hook",
          },
        ],
      }),
    );
    expect(answer.ok).toBe(true);
    expect(answer.lines).toEqual([
      "API Key: Valid (test mode)",
      "Webhooks: 2 endpoint(s)",
      "  enabled - https://example.com/payment/webhook (tickets)",
      "  Events: checkout.session.completed",
      "  disabled - https://other.example/hook",
      "  Events: charge.refunded, payment_intent.succeeded",
    ]);
  });
});

const squareResult = (
  over: Partial<SquareConnectionTestResult>,
): SquareConnectionTestResult => ({
  accessToken: { mode: "sandbox", valid: true },
  location: { configured: false },
  ok: false,
  webhook: { configured: false },
  ...over,
});

describe("squareConnectionAnswer", () => {
  test("names the token, the place, and the webhook key", () => {
    const answer = squareConnectionAnswer(
      squareResult({
        location: {
          configured: true,
          locationId: "L1",
          name: "The Shop",
          status: "ACTIVE",
        },
        ok: true,
        webhook: { configured: true },
      }),
    );
    expect(answer.ok).toBe(true);
    expect(answer.lines).toEqual([
      "Access Token: Valid (sandbox mode)",
      "Location: The Shop (ACTIVE)",
      "Webhook: Signature key configured",
    ]);
  });

  test("falls back to the location id and skips an absent status", () => {
    const answer = squareConnectionAnswer(
      squareResult({
        location: { configured: true, locationId: "L2", name: "" },
      }),
    );
    expect(answer.lines[1]).toBe("Location: L2");
  });

  test("names a missing location, with its reason when there is one", () => {
    const withReason = squareConnectionAnswer(
      squareResult({
        location: { configured: false, error: "Location ID not found" },
      }),
    );
    const bare = squareConnectionAnswer(squareResult({}));
    expect(withReason.lines[1]).toBe(
      "Location: Not configured - Location ID not found",
    );
    expect(bare.lines[1]).toBe("Location: Not configured");
  });

  test("names a missing webhook key", () => {
    const answer = squareConnectionAnswer(
      squareResult({ webhook: { configured: false, error: "no key" } }),
    );
    expect(answer.lines[2]).toBe("Webhook: Not configured - no key");
  });

  test("names an invalid token with its reason", () => {
    const answer = squareConnectionAnswer(
      squareResult({ accessToken: { error: "expired", valid: false } }),
    );
    expect(answer.lines[0]).toBe("Access Token: Invalid - expired");
  });
});

const sumupResult = (
  over: Partial<SumupConnectionTestResult>,
): SumupConnectionTestResult => ({
  apiKey: { mode: "test", valid: true },
  currency: { code: "GBP", supported: true },
  merchant: { configured: false },
  ok: false,
  ...over,
});

describe("sumupConnectionAnswer", () => {
  test("names the key, the merchant, and a supported currency", () => {
    const answer = sumupConnectionAnswer(
      sumupResult({
        merchant: { configured: true, merchantCode: "MCODE" },
        ok: true,
      }),
    );
    expect(answer.ok).toBe(true);
    expect(answer.lines).toEqual([
      "API Key: Valid (test mode)",
      "Merchant: MCODE",
      "Currency: GBP (supported)",
    ]);
  });

  test("a rejected key answers with the key line alone", () => {
    const answer = sumupConnectionAnswer(
      sumupResult({ apiKey: { error: "unauthorized", valid: false } }),
    );
    expect(answer.lines).toEqual(["API Key: Invalid - unauthorized"]);
  });

  test("names a missing merchant, with its reason when there is one", () => {
    const withReason = sumupConnectionAnswer(
      sumupResult({ merchant: { configured: false, error: "not found" } }),
    );
    const bare = sumupConnectionAnswer(sumupResult({}));
    expect(withReason.lines[1]).toBe("Merchant: Not configured - not found");
    expect(bare.lines[1]).toBe("Merchant: Not configured");
  });

  test("names a currency SumUp does not support", () => {
    const answer = sumupConnectionAnswer(
      sumupResult({ currency: { code: "XYZ", supported: false } }),
    );
    expect(answer.lines[2]).toBe("Currency: XYZ is not supported by SumUp");
  });
});
