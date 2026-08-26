import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import type { PaymentProviderMode } from "#shared/payment-provider-status.ts";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
} from "#shared/payment-providers.ts";
import {
  PaymentProviderForm,
  ProviderCredentialsForm,
  SquareWebhookForm,
} from "#templates/admin/settings/payment.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { defaultSettingsState } from "#test/ui/templates/admin/settings-state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasCheckedInput, inputTagWithValue } from "#test-utils/csrf.ts";
import type { PaymentProviderType } from "#types";

/** Render one payment form over the default state plus the given overrides. */
const render = (
  form: (s: SettingsPageState) => JSX.Element | null,
  overrides: Partial<SettingsPageState> = {},
): string => String(form({ ...defaultSettingsState(), ...overrides }) ?? "");

/** The page state that shows one provider's credentials form. */
const showing = (
  provider: PaymentProviderType,
  values: { configured?: boolean; mode?: PaymentProviderMode } = {},
): Partial<SettingsPageState> => ({
  shownPaymentProvider: {
    configured: values.configured ?? false,
    mode: values.mode ?? "unknown",
    provider,
  },
});

/** One provider's credentials form as HTML. */
const credentials = (
  provider: PaymentProviderType,
  values: { configured?: boolean; mode?: PaymentProviderMode } = {},
): string => render(ProviderCredentialsForm, showing(provider, values));

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
        expect(html).toContain(
          `${inputTagWithValue(html, id)}${PAYMENT_PROVIDERS[id].label}`,
        );
      }
    });

    test("checks exactly the radio matching the saved provider", () => {
      const values: Array<"none" | (typeof PAYMENT_PROVIDER_IDS)[number]> = [
        "none",
        ...PAYMENT_PROVIDER_IDS,
      ];
      for (const selected of values) {
        const html = render(PaymentProviderForm, {
          paymentProvider: selected === "none" ? null : selected,
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
        expect(inputTagWithValue(html, id)).not.toContain("disabled");
      }
      expect(html).not.toContain('<small class="notice">');
    });

    test("switches off a provider that cannot take the site currency", () => {
      const html = render(PaymentProviderForm, { currency: "JPY" });
      expect(inputTagWithValue(html, "sumup")).toContain("disabled");
      expect(inputTagWithValue(html, "stripe")).not.toContain("disabled");
      expect(inputTagWithValue(html, "square")).not.toContain("disabled");
      expect(html).toContain(
        '<small class="notice">SumUp cannot take payments in JPY. ' +
          "Choose a different payment provider.</small>",
      );
    });
  });

  describe("ProviderCredentialsForm", () => {
    test("renders nothing until a provider is chosen or remembered", () => {
      expect(render(ProviderCredentialsForm)).toBe("");
    });

    for (const provider of PAYMENT_PROVIDER_IDS) {
      const { label, secretField } = PAYMENT_PROVIDERS[provider];

      test(`posts ${label} credentials to that provider's own route`, () => {
        const html = credentials(provider);
        expect(html).toContain(`action="/admin/settings/${provider}"`);
        expect(html).toContain(`id="settings-${provider}"`);
        expect(html).toContain(`name="${secretField}"`);
      });

      test(`opens ${label} with the not-configured hint and the guide link`, () => {
        const html = credentials(provider);
        expect(html).toContain('<div class="prose">');
        expect(html).toContain(`<h2>${label} settings</h2>`);
        expect(html).toContain(`No ${label} credentials are saved`);
        expect(html).toContain('href="/admin/guide#payment-setup"');
        expect(html).toContain("Read the payment setup guide");
      });

      test(`swaps in the configured hint and masks the stored ${label} secret`, () => {
        const html = credentials(provider, { configured: true });
        expect(html).toContain(`Your ${label} credentials are saved`);
        const field = html.match(
          new RegExp(`<input[^>]*name="${secretField}"[^>]*>`),
        )?.[0];
        expect(field).toContain(`value="${MASK_SENTINEL}"`);
      });

      test(`leaves the ${label} secret field empty when none is stored`, () => {
        expect(credentials(provider)).not.toContain(MASK_SENTINEL);
      });

      test(`offers ${label} a connection test only once it is configured`, () => {
        const configured = credentials(provider, { configured: true });
        expect(configured).toContain(
          `<button class="secondary" id="${provider}-test-btn"`,
        );
        expect(configured).toContain("Test connection");
        expect(configured).toContain(
          `<div class="hidden" id="${provider}-test-result"`,
        );

        const blank = credentials(provider);
        expect(blank).not.toContain(`id="${provider}-test-btn"`);
        expect(blank).toContain(
          `<div class="hidden" id="${provider}-test-result"`,
        );
      });

      test(`names ${label} on its save button`, () => {
        expect(credentials(provider)).toContain(`Update ${label} credentials`);
      });
    }

    // The form follows the money, not the sales switch: a provider that owns
    // payments already taken still needs its keys reachable.
    test("stays available while sales are off", () => {
      const html = render(ProviderCredentialsForm, {
        paymentProvider: null,
        ...showing("stripe"),
      });
      expect(html).toContain('id="settings-stripe"');
    });

    for (const [mode, opening, style] of [
      ["test", "Test mode:", 'class="notice warning"'],
      ["live", "Live mode:", 'class="notice"'],
      ["sandbox", "Sandbox mode:", 'class="notice warning"'],
    ] as const) {
      test(`warns that stored credentials point at the ${mode} estate`, () => {
        const html = credentials("stripe", { configured: true, mode });
        expect(html).toContain(`<p ${style}>`);
        expect(html).toContain(opening);
        expect(html).toContain("Stripe");
      });
    }

    test("says nothing about the estate when the credentials do not name one", () => {
      const html = credentials("stripe", { configured: true, mode: "unknown" });
      expect(html).not.toContain("mode:");
    });

    test("says nothing about the estate until credentials are stored", () => {
      const html = credentials("stripe", { mode: "test" });
      expect(html).not.toContain("Test mode:");
    });

    test("offers the sandbox switch to Square alone", () => {
      const square = credentials("square");
      const checkbox = square.match(/<input[^>]*name="square_sandbox"[^>]*>/);
      expect(checkbox?.[0]).toContain('type="checkbox"');
      expect(checkbox?.[0]).not.toContain("checked");
      expect(credentials("stripe")).not.toContain('name="square_sandbox"');
      expect(credentials("sumup")).not.toContain('name="square_sandbox"');
    });

    test("checks the sandbox switch when Square points at its test estate", () => {
      const html = credentials("square", { mode: "sandbox" });
      const checkbox = html.match(/<input[^>]*name="square_sandbox"[^>]*>/);
      expect(checkbox?.[0]).toContain("checked");
    });
  });

  describe("SquareWebhookForm", () => {
    test("waits for a Square access token before asking for the webhook key", () => {
      expect(render(SquareWebhookForm, showing("square"))).toBe("");
      expect(
        render(SquareWebhookForm, showing("stripe", { configured: true })),
      ).toBe("");
    });

    test("stays available for existing Square payments while sales are off", () => {
      const html = render(SquareWebhookForm, {
        paymentProvider: null,
        ...showing("square", { configured: true }),
      });
      expect(html).toContain('id="settings-square-webhook"');
    });

    test("posts the signature key to the Square webhook route", () => {
      const html = render(
        SquareWebhookForm,
        showing("square", {
          configured: true,
        }),
      );
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
        squareWebhookConfigured: true,
        ...showing("square", { configured: true }),
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
