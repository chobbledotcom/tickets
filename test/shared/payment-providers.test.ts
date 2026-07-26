import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
  providerCurrencyBlock,
  WEBHOOK_SIGNATURE_HEADERS,
} from "#shared/payment-providers.ts";

describe("payment provider registry", () => {
  describe("providerCurrencyBlock", () => {
    test("allows a currency SumUp can charge, whatever the case", () => {
      expect(providerCurrencyBlock("sumup", "gbp")).toBeNull();
      expect(providerCurrencyBlock("sumup", "EUR")).toBeNull();
    });

    test("explains which provider cannot take which currency", () => {
      expect(providerCurrencyBlock("sumup", "JPY")).toBe(
        "SumUp cannot take payments in JPY. Choose a different payment provider.",
      );
      expect(providerCurrencyBlock("sumup", "AUD")).toBe(
        "SumUp cannot take payments in AUD. Choose a different payment provider.",
      );
    });

    test("allows any currency for a provider with no currency list", () => {
      expect(PAYMENT_PROVIDERS.stripe.currencies).toBeNull();
      expect(PAYMENT_PROVIDERS.square.currencies).toBeNull();
      for (const currency of ["JPY", "AUD", "gbp"]) {
        expect(providerCurrencyBlock("stripe", currency)).toBeNull();
        expect(providerCurrencyBlock("square", currency)).toBeNull();
      }
    });

    test("every provider takes the default GBP site currency", () => {
      for (const id of PAYMENT_PROVIDER_IDS) {
        expect(providerCurrencyBlock(id, "GBP")).toBeNull();
      }
    });

    test("takes exactly the currencies SumUp's checkout API lists", () => {
      expect([...PAYMENT_PROVIDERS.sumup.currencies].sort()).toEqual([
        "BGN",
        "BRL",
        "CHF",
        "CLP",
        "COP",
        "CZK",
        "DKK",
        "EUR",
        "GBP",
        "HRK",
        "HUF",
        "NOK",
        "PLN",
        "RON",
        "SEK",
        "USD",
      ]);
    });
  });

  test("records each provider's label and checkout-metadata caps", () => {
    expect(PAYMENT_PROVIDERS.square.label).toBe("Square");
    expect(PAYMENT_PROVIDERS.square.metadata).toEqual({
      maxEntries: 10,
      maxValueLength: 255,
      packs: true,
    });
    expect(PAYMENT_PROVIDERS.stripe.label).toBe("Stripe");
    expect(PAYMENT_PROVIDERS.stripe.metadata).toEqual({
      maxEntries: 50,
      maxValueLength: 500,
      packs: false,
    });
    expect(PAYMENT_PROVIDERS.sumup.label).toBe("SumUp");
    expect(PAYMENT_PROVIDERS.sumup.metadata).toEqual({
      maxValueLength: Number.POSITIVE_INFINITY,
      packs: false,
    });
  });

  test("lists the providers in the order operators see them", () => {
    expect(PAYMENT_PROVIDER_IDS).toEqual(["square", "stripe", "sumup"]);
  });

  test("has no signature header for SumUp, whose webhooks are unsigned", () => {
    expect(PAYMENT_PROVIDERS.sumup.webhookSignatureHeader).toBeNull();
  });

  test("lists the signature header of every provider that signs webhooks", () => {
    expect(WEBHOOK_SIGNATURE_HEADERS).toEqual([
      "x-square-hmacsha256-signature",
      "stripe-signature",
    ]);
  });
});
