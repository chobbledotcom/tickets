import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
  providerCheckoutFormOrigins,
  providerCurrencyBlock,
  providerWebhook,
  WEBHOOK_SIGNATURE_HEADERS,
} from "#shared/payment-providers.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";

const messages = await allEnglishMessages();

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

  test("declares no webhook for SumUp, which sends none", () => {
    expect(PAYMENT_PROVIDERS.sumup.webhook).toBeNull();
  });

  test("lists the signature header of every provider that signs webhooks", () => {
    expect(WEBHOOK_SIGNATURE_HEADERS).toEqual([
      "x-square-hmacsha256-signature",
      "stripe-signature",
    ]);
  });

  describe("every provider fact is declared exactly once", () => {
    test("names the checkout origins the buyer's form posts to", () => {
      for (const id of PAYMENT_PROVIDER_IDS) {
        // A provider with no origins would get `form-action 'self'`, and the
        // browser would block the buyer's redirect to its hosted checkout.
        expect(providerCheckoutFormOrigins(id, false).length).toBeGreaterThan(
          0,
        );
        expect(providerCheckoutFormOrigins(id, true).length).toBeGreaterThan(0);
      }
    });

    test("falls back to the live origins for a provider with no sandbox", () => {
      expect(providerCheckoutFormOrigins("stripe", true)).toEqual(
        providerCheckoutFormOrigins("stripe", false),
      );
      expect(providerCheckoutFormOrigins("square", true)).not.toEqual(
        providerCheckoutFormOrigins("square", false),
      );
    });

    test("declares a refund capability for every provider", () => {
      for (const id of PAYMENT_PROVIDER_IDS) {
        expect(["keyed", "keyless"]).toContain(
          PAYMENT_PROVIDERS[id].refundCapability,
        );
      }
    });

    test("lists exactly the headers of the providers that send webhooks", () => {
      const headers = PAYMENT_PROVIDER_IDS.map(
        (id) => providerWebhook(id)?.signatureHeader,
      ).filter((header) => header !== undefined);
      expect(WEBHOOK_SIGNATURE_HEADERS).toEqual(headers);
    });

    test("gives every webhook provider real copy for a domain change", () => {
      for (const id of PAYMENT_PROVIDER_IDS) {
        const webhook = providerWebhook(id);
        if (webhook === null) continue;
        expect(messages[webhook.domainChangeFixKey]).toBeTruthy();
      }
    });
  });
});
