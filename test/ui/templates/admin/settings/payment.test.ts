import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#shared/db/settings/mask.ts";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
} from "#shared/payment-providers.ts";
import {
  PaymentProviderForm,
  SquareForm,
  SquareWebhookForm,
  StripeForm,
  SumUpForm,
} from "#templates/admin/settings/payment.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { defaultSettingsState } from "#test/ui/templates/admin/settings-state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";

/** Render one payment form over the default state plus the given overrides. */
const render = (
  form: (s: SettingsPageState) => JSX.Element | null,
  overrides: Partial<SettingsPageState> = {},
): string => String(form({ ...defaultSettingsState(), ...overrides }) ?? "");

/** The `<input>` tag rendered for one radio value. */
const inputForValue = (html: string, value: string): string =>
  html.match(new RegExp(`<input\\b[^>]*value="${value}"[^>]*>`))?.[0] ?? "";

describe("settings payment forms", () => {
  beforeAll(setupAdminPageTest);

  describe("PaymentProviderForm", () => {
    test("posts the provider choice to its own settings route", () => {
      const html = render(PaymentProviderForm);
      expect(html).toContain('action="/admin/settings/payment-provider"');
      expect(html).toContain('id="settings-payment-provider"');
      expect(html).toContain('<div class="prose">');
      expect(html).toContain('<fieldset class="radios">');
    });

    test("attaches each registry label to its own radio value", () => {
      const html = render(PaymentProviderForm);
      for (const id of PAYMENT_PROVIDER_IDS) {
        const label = PAYMENT_PROVIDERS[id].label;
        expect(html).toContain(`${inputForValue(html, id)}${label}`);
      }
    });

    test("checks exactly the radio matching the saved provider", () => {
      const values = ["none", ...PAYMENT_PROVIDER_IDS];
      for (const selected of values) {
        const html = render(PaymentProviderForm, {
          paymentProvider: selected === "none" ? "" : selected,
        });
        for (const value of values) {
          expect(hasCheckedInput(html, "payment_provider", value)).toBe(
            value === selected,
          );
        }
      }
    });

    test("offers every provider when the site currency suits them all", () => {
      const html = render(PaymentProviderForm, { currency: "GBP" });
      for (const id of PAYMENT_PROVIDER_IDS) {
        expect(inputForValue(html, id)).not.toContain("disabled");
      }
      expect(html).not.toContain("cannot take payments in");
    });

    test("switches off a provider that cannot take the site currency", () => {
      const html = render(PaymentProviderForm, { currency: "JPY" });
      expect(inputForValue(html, "sumup")).toContain("disabled");
      expect(inputForValue(html, "stripe")).not.toContain("disabled");
      expect(inputForValue(html, "square")).not.toContain("disabled");
      expect(html).toContain(
        '<small class="notice">SumUp cannot take payments in JPY. ' +
          "Choose a different payment provider.</small>",
      );
    });
  });

  describe("StripeForm", () => {
    test("renders nothing unless Stripe is the chosen provider", () => {
      expect(render(StripeForm)).toBe("");
      expect(render(StripeForm, { paymentProvider: "square" })).toBe("");
    });

    test("posts the key to the Stripe settings route", () => {
      const html = render(StripeForm, { paymentProvider: "stripe" });
      expect(html).toContain('action="/admin/settings/stripe"');
      expect(html).toContain('id="settings-stripe"');
      expect(html).toContain('name="stripe_secret_key"');
    });

    test("opens with the not-configured hint and the guide link", () => {
      const html = render(StripeForm, { paymentProvider: "stripe" });
      expect(html).toContain('<div class="prose">');
      expect(html).toContain("No Stripe key is configured");
      expect(html).toContain('href="/admin/guide#payment-setup"');
    });

    test("swaps in the configured hint and masks the stored key", () => {
      const html = render(StripeForm, {
        paymentProvider: "stripe",
        stripeKeyConfigured: true,
      });
      expect(html).toContain("A Stripe secret key is currently configured");
      expect(html).toContain(MASK_SENTINEL);
    });

    test("leaves the key field empty when no key is stored", () => {
      const html = render(StripeForm, { paymentProvider: "stripe" });
      expect(html).not.toContain(MASK_SENTINEL);
    });

    test("offers Test Connection only once a key is stored", () => {
      const configured = render(StripeForm, {
        paymentProvider: "stripe",
        stripeKeyConfigured: true,
      });
      expect(configured).toContain(
        '<button class="secondary" id="stripe-test-btn"',
      );
      expect(configured).toContain(
        '<div class="hidden" id="stripe-test-result"',
      );

      const blank = render(StripeForm, { paymentProvider: "stripe" });
      expect(blank).not.toContain('id="stripe-test-btn"');
      expect(blank).toContain('<div class="hidden" id="stripe-test-result"');
    });

    test("warns that a test key takes no real money", () => {
      const html = render(StripeForm, {
        paymentProvider: "stripe",
        stripeKeyConfigured: true,
        stripeKeyMode: "test",
      });
      expect(html).toContain('<p class="notice warning">');
      expect(html).toContain("Test mode:");
      expect(html).toContain("You are using a Stripe test key");
    });

    test("confirms that a live key charges for real", () => {
      const html = render(StripeForm, {
        paymentProvider: "stripe",
        stripeKeyConfigured: true,
        stripeKeyMode: "live",
      });
      expect(html).toContain('<p class="notice">');
      expect(html).toContain("Live mode:");
      expect(html).toContain("You are using a Stripe live key");
    });

    test("says nothing about the mode until a key is stored", () => {
      const html = render(StripeForm, {
        paymentProvider: "stripe",
        stripeKeyMode: "test",
      });
      expect(html).not.toContain("Test mode:");
      expect(html).not.toContain("Live mode:");
    });
  });

  describe("SumUpForm", () => {
    test("renders nothing unless SumUp is the chosen provider", () => {
      expect(render(SumUpForm)).toBe("");
      expect(render(SumUpForm, { paymentProvider: "stripe" })).toBe("");
    });

    test("posts the credentials to the SumUp settings route", () => {
      const html = render(SumUpForm, { paymentProvider: "sumup" });
      expect(html).toContain('action="/admin/settings/sumup"');
      expect(html).toContain('id="settings-sumup"');
      expect(html).toContain('name="sumup_api_key"');
    });

    test("names SumUp in its mode notice and test button", () => {
      const html = render(SumUpForm, {
        paymentProvider: "sumup",
        sumupKeyConfigured: true,
        sumupKeyMode: "test",
      });
      expect(html).toContain("You are using a SumUp test key");
      expect(html).toContain('id="sumup-test-btn"');
      expect(html).toContain('id="sumup-test-result"');
    });

    test("masks the stored API key", () => {
      const html = render(SumUpForm, {
        paymentProvider: "sumup",
        sumupKeyConfigured: true,
      });
      const field = html.match(/<input[^>]*name="sumup_api_key"[^>]*>/)?.[0];
      expect(field).toContain(`value="${MASK_SENTINEL}"`);
    });

    test("leaves the API key field empty when no key is stored", () => {
      const html = render(SumUpForm, { paymentProvider: "sumup" });
      expect(html).not.toContain(MASK_SENTINEL);
    });
  });

  describe("SquareForm", () => {
    test("renders nothing unless Square is the chosen provider", () => {
      expect(render(SquareForm)).toBe("");
      expect(render(SquareForm, { paymentProvider: "stripe" })).toBe("");
    });

    test("posts the access token to the Square settings route", () => {
      const html = render(SquareForm, { paymentProvider: "square" });
      expect(html).toContain('action="/admin/settings/square"');
      expect(html).toContain('id="settings-square"');
      expect(html).toContain('name="square_access_token"');
      expect(html).not.toContain(MASK_SENTINEL);
    });

    test("masks the stored token and offers Test Connection", () => {
      const html = render(SquareForm, {
        paymentProvider: "square",
        squareTokenConfigured: true,
      });
      expect(html).toContain(MASK_SENTINEL);
      expect(html).toContain('<button class="secondary" id="square-test-btn"');
      expect(html).toContain('<div class="hidden" id="square-test-result">');
    });

    test("hides Test Connection until a token is stored", () => {
      const html = render(SquareForm, { paymentProvider: "square" });
      expect(html).not.toContain('id="square-test-btn"');
      expect(html).toContain('<div class="hidden" id="square-test-result">');
    });

    test("renders the sandbox toggle as a checkbox", () => {
      const html = render(SquareForm, { paymentProvider: "square" });
      const checkbox = html.match(/<input[^>]*name="square_sandbox"[^>]*>/);
      expect(checkbox?.[0]).toContain('type="checkbox"');
      expect(checkbox?.[0]).not.toContain("checked");
    });

    test("checks the sandbox toggle when sandbox mode is on", () => {
      const html = render(SquareForm, {
        paymentProvider: "square",
        squareSandbox: true,
      });
      const checkbox = html.match(/<input[^>]*name="square_sandbox"[^>]*>/);
      expect(checkbox?.[0]).toContain("checked");
    });
  });

  describe("SquareWebhookForm", () => {
    test("waits for a Square access token before asking for the webhook key", () => {
      expect(render(SquareWebhookForm, { paymentProvider: "square" })).toBe("");
      expect(
        render(SquareWebhookForm, {
          paymentProvider: "stripe",
          squareTokenConfigured: true,
        }),
      ).toBe("");
    });

    test("posts the signature key to the Square webhook route", () => {
      const html = render(SquareWebhookForm, {
        paymentProvider: "square",
        squareTokenConfigured: true,
      });
      expect(html).toContain('action="/admin/settings/square-webhook"');
      expect(html).toContain('id="settings-square-webhook"');
      expect(html).toContain('<div class="prose">');
      expect(html).toContain('href="/admin/guide#payment-setup"');
      expect(html).toContain("No webhook signature key is configured");
      expect(html).toContain("Follow the steps above to set one up");
      expect(html).not.toContain(MASK_SENTINEL);
    });

    test("swaps in the configured hint once a key is stored", () => {
      const html = render(SquareWebhookForm, {
        paymentProvider: "square",
        squareTokenConfigured: true,
        squareWebhookConfigured: true,
      });
      expect(html).toContain("A webhook signature key is currently configured");
      expect(html).toContain("Enter a new key below to replace it");
      const field = html.match(
        /<input[^>]*name="square_webhook_signature_key"[^>]*>/,
      )?.[0];
      expect(field).toContain(`value="${MASK_SENTINEL}"`);
    });
  });
});
