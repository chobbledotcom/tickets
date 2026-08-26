/**
 * The words each provider's test answer turns into. Every provider reports
 * different facts, so each has its own shapes to read back.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { usePaymentButtonPage, VALID_KEY } from "./page.ts";

describe("reading a payment provider's test answer", () => {
  const page = usePaymentButtonPage();

  describe("Stripe", () => {
    for (const [name, apiKey, expected] of [
      ["a working key with its mode", VALID_KEY, "API Key: Valid (test mode)"],
      [
        "a refused key and why",
        { error: "expired", valid: false },
        "API Key: Invalid - expired",
      ],
      ["a refused key with no reason", { valid: false }, "API Key: Invalid"],
    ] as const) {
      test(`reports ${name}`, async () => {
        const { lines } = await page.press("stripe", {
          data: { apiKey, ok: true },
        });
        expect(lines[0]).toBe(expected);
      });
    }

    test("lists each webhook endpoint, marking the one we made", async () => {
      const { lines } = await page.press("stripe", {
        data: {
          apiKey: VALID_KEY,
          ok: true,
          ownEndpointId: "we_ours",
          webhooks: [
            {
              enabledEvents: ["checkout.session.completed"],
              endpointId: "we_ours",
              status: "enabled",
              url: "https://ours.example/webhook",
            },
            {
              enabledEvents: ["charge.refunded", "payment_intent.succeeded"],
              endpointId: "we_theirs",
              status: "disabled",
              url: "https://theirs.example/webhook",
            },
          ],
        },
      });
      expect(lines.slice(1)).toEqual([
        "Webhooks: 2 endpoint(s)",
        "  enabled - https://ours.example/webhook (tickets)",
        "  Events: checkout.session.completed",
        "  disabled - https://theirs.example/webhook",
        "  Events: charge.refunded, payment_intent.succeeded",
      ]);
    });

    test("says when Stripe has no webhook endpoints at all", async () => {
      const { lines } = await page.press("stripe", {
        data: { apiKey: VALID_KEY, ok: true, webhooks: [] },
      });
      expect(lines[1]).toBe("Webhooks: None configured");
    });

    test("passes on the reason the webhook list could not be read", async () => {
      const { lines } = await page.press("stripe", {
        data: { apiKey: VALID_KEY, ok: false, webhookError: "no permission" },
      });
      expect(lines[1]).toBe("Webhooks: Error - no permission");
    });
  });

  describe("Square", () => {
    const squareData = (
      location: unknown,
      webhook: unknown = { configured: true },
    ) => ({
      accessToken: { mode: "live", valid: true },
      location,
      ok: true,
      webhook,
    });

    test("names the token, the location and the signature key", async () => {
      const { lines } = await page.press("square", {
        data: squareData({
          configured: true,
          locationId: "L1",
          name: "The Hall",
          status: "ACTIVE",
        }),
      });
      expect(lines).toEqual([
        "Access Token: Valid (live mode)",
        "Location: The Hall (ACTIVE)",
        "Webhook: Signature key configured",
      ]);
    });

    for (const [name, location, expected] of [
      [
        "falls back to the location id when Square names none",
        { configured: true, locationId: "L1" },
        "Location: L1",
      ],
      [
        "falls back to the location id when Square sends a blank name",
        { configured: true, locationId: "L1", name: "" },
        "Location: L1",
      ],
      [
        "reports a missing location and why",
        { configured: false, error: "not found" },
        "Location: Not configured - not found",
      ],
      [
        "reports a missing location with no reason",
        { configured: false },
        "Location: Not configured",
      ],
    ] as const) {
      test(name, async () => {
        const { lines } = await page.press("square", {
          data: squareData(location),
        });
        expect(lines[1]).toBe(expected);
      });
    }

    for (const [name, webhook, expected] of [
      [
        "reports a missing signature key and why",
        { configured: false, error: "none set" },
        "Webhook: Not configured - none set",
      ],
      [
        "reports a missing signature key with no reason",
        { configured: false },
        "Webhook: Not configured",
      ],
    ] as const) {
      test(name, async () => {
        const { lines } = await page.press("square", {
          data: squareData({ configured: true, locationId: "L1" }, webhook),
        });
        expect(lines[2]).toBe(expected);
      });
    }
  });

  describe("SumUp", () => {
    // A refused key means the merchant lookup never ran, so the two lines
    // below it would be guesses rather than facts.
    test("says only what a refused key proves", async () => {
      const { lines } = await page.press("sumup", {
        data: {
          apiKey: { error: "revoked", valid: false },
          currency: { code: "GBP", supported: true },
          merchant: { configured: true, merchantCode: "MC1" },
          ok: false,
        },
      });
      expect(lines).toEqual(["API Key: Invalid - revoked"]);
    });

    test("names the merchant and the currency behind a working key", async () => {
      const { lines } = await page.press("sumup", {
        data: {
          apiKey: VALID_KEY,
          currency: { code: "GBP", supported: true },
          merchant: { configured: true, merchantCode: "MC1" },
          ok: true,
        },
      });
      expect(lines).toEqual([
        "API Key: Valid (test mode)",
        "Merchant: MC1",
        "Currency: GBP (supported)",
      ]);
    });

    for (const [name, merchant, expected] of [
      [
        "reports a missing merchant and why",
        { configured: false, error: "no account" },
        "Merchant: Not configured - no account",
      ],
      [
        "reports a missing merchant with no reason",
        { configured: false },
        "Merchant: Not configured",
      ],
    ] as const) {
      test(name, async () => {
        const { lines } = await page.press("sumup", {
          data: {
            apiKey: VALID_KEY,
            currency: { code: "GBP", supported: true },
            merchant,
            ok: false,
          },
        });
        expect(lines[1]).toBe(expected);
      });
    }

    test("warns when SumUp cannot take the site currency", async () => {
      const { lines } = await page.press("sumup", {
        data: {
          apiKey: VALID_KEY,
          currency: { code: "JPY", supported: false },
          merchant: { configured: true, merchantCode: "MC1" },
          ok: false,
        },
      });
      expect(lines[2]).toBe("Currency: JPY is not supported by SumUp");
    });
  });
});
