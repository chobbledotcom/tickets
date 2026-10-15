import { assert, assertStringIncludes } from "@std/assert";
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
      assertStringIncludes(html, 'action="/admin/settings/payment-provider"');
      assertStringIncludes(html, 'id="settings-payment-provider"');
      assertStringIncludes(html, '<div class="prose">');
      assertStringIncludes(html, '<fieldset class="radios">');
    });

    test("attaches each registry label to its own radio value", () => {
      const html = render(PaymentProviderForm);
      for (const id of PAYMENT_PROVIDER_IDS) {
        assertStringIncludes(
          html,
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
        assert(
          !inputTagWithValue(html, id).includes("disabled"),
          "the value should not contain the searched item",
        );
      }
      assert(
        !html.includes('<small class="notice">'),
        "the value should not contain the searched item",
      );
    });

    test("switches off a provider that cannot take the site currency", () => {
      const html = render(PaymentProviderForm, { currency: "JPY" });
      assertStringIncludes(inputTagWithValue(html, "sumup"), "disabled");
      assert(
        !inputTagWithValue(html, "stripe").includes("disabled"),
        "the value should not contain the searched item",
      );
      assert(
        !inputTagWithValue(html, "square").includes("disabled"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(
        html,
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
        assertStringIncludes(html, `action="/admin/settings/${provider}"`);
        assertStringIncludes(html, `id="settings-${provider}"`);
        assertStringIncludes(html, `name="${secretField}"`);
      });

      test(`opens ${label} with the not-configured hint and the guide link`, () => {
        const html = credentials(provider);
        assertStringIncludes(html, '<div class="prose">');
        assertStringIncludes(html, `<h2>${label} settings</h2>`);
        assertStringIncludes(html, `No ${label} credentials are saved`);
        assertStringIncludes(html, 'href="/admin/guide#payment-setup"');
        assertStringIncludes(html, "Read the payment setup guide");
      });

      test(`swaps in the configured hint and masks the stored ${label} secret`, () => {
        const html = credentials(provider, { configured: true });
        assertStringIncludes(html, `Your ${label} credentials are saved`);
        const field = html.match(
          new RegExp(`<input[^>]*name="${secretField}"[^>]*>`),
        )?.[0];
        assertStringIncludes(field ?? "", `value="${MASK_SENTINEL}"`);
      });

      test(`leaves the ${label} secret field empty when none is stored`, () => {
        assert(
          !credentials(provider).includes(MASK_SENTINEL),
          "the value should not contain the searched item",
        );
      });

      test(`offers ${label} a connection test only once it is configured`, () => {
        const configured = credentials(provider, { configured: true });
        assertStringIncludes(
          configured,
          `<button class="secondary" data-testing="Testing..." id="${provider}-test-btn"`,
        );
        assertStringIncludes(configured, "Test connection");
        assertStringIncludes(
          configured,
          `<div class="hidden" data-failed="Connection test failed:" id="${provider}-test-result"`,
        );

        const blank = credentials(provider);
        assert(
          !blank.includes(`id="${provider}-test-btn"`),
          "the value should not contain the searched item",
        );
        assertStringIncludes(
          blank,
          `<div class="hidden" data-failed="Connection test failed:" id="${provider}-test-result"`,
        );
      });

      test(`names ${label} on its save button`, () => {
        assertStringIncludes(
          credentials(provider),
          `Update ${label} credentials`,
        );
      });
    }

    // The form follows the money, not the sales switch: a provider that owns
    // payments already taken still needs its keys reachable.
    test("stays available while sales are off", () => {
      const html = render(ProviderCredentialsForm, {
        paymentProvider: null,
        ...showing("stripe"),
      });
      assertStringIncludes(html, 'id="settings-stripe"');
    });

    for (const [mode, opening, style] of [
      ["test", "Test mode:", 'class="notice warning"'],
      ["live", "Live mode:", 'class="notice"'],
      ["sandbox", "Sandbox mode:", 'class="notice warning"'],
    ] as const) {
      test(`warns that stored credentials point at the ${mode} estate`, () => {
        const html = credentials("stripe", { configured: true, mode });
        assertStringIncludes(html, `<p ${style}>`);
        assertStringIncludes(html, opening);
        assertStringIncludes(html, "Stripe");
      });
    }

    test("says nothing about the estate when the credentials do not name one", () => {
      const html = credentials("stripe", { configured: true, mode: "unknown" });
      assert(
        !html.includes("mode:"),
        "the value should not contain the searched item",
      );
    });

    test("says nothing about the estate until credentials are stored", () => {
      const html = credentials("stripe", { mode: "test" });
      assert(
        !html.includes("Test mode:"),
        "the value should not contain the searched item",
      );
    });

    test("offers the sandbox switch to Square alone", () => {
      const square = credentials("square");
      const checkbox = square.match(/<input[^>]*name="square_sandbox"[^>]*>/);
      const cell = checkbox?.[0];
      assertStringIncludes(cell ?? "", 'type="checkbox"');
      assert(
        cell !== undefined && !cell.includes("checked"),
        "the value should not contain the searched item",
      );
      assert(
        !credentials("stripe").includes('name="square_sandbox"'),
        "the value should not contain the searched item",
      );
      assert(
        !credentials("sumup").includes('name="square_sandbox"'),
        "the value should not contain the searched item",
      );
    });

    test("checks the sandbox switch when Square points at its test estate", () => {
      const html = credentials("square", { mode: "sandbox" });
      const checkbox = html.match(/<input[^>]*name="square_sandbox"[^>]*>/);
      assertStringIncludes(checkbox?.[0] ?? "", "checked");
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
      assertStringIncludes(html, 'id="settings-square-webhook"');
    });

    test("posts the signature key to the Square webhook route", () => {
      const html = render(
        SquareWebhookForm,
        showing("square", {
          configured: true,
        }),
      );
      assertStringIncludes(html, 'action="/admin/settings/square-webhook"');
      assertStringIncludes(html, 'id="settings-square-webhook"');
      assertStringIncludes(html, '<div class="prose">');
      assertStringIncludes(html, 'href="/admin/guide#payment-setup"');
      assertStringIncludes(html, "No webhook signature key is configured");
      assertStringIncludes(html, "Follow the steps above to set one up");
      assert(
        !html.includes(MASK_SENTINEL),
        "the value should not contain the searched item",
      );
    });

    test("swaps in the configured hint once a key is stored", () => {
      const html = render(SquareWebhookForm, {
        squareWebhookConfigured: true,
        ...showing("square", { configured: true }),
      });
      assertStringIncludes(
        html,
        "A webhook signature key is currently configured",
      );
      assertStringIncludes(html, "Enter a new key below to replace it");
      const field = html.match(
        /<input[^>]*name="square_webhook_signature_key"[^>]*>/,
      )?.[0];
      assertStringIncludes(field ?? "", `value="${MASK_SENTINEL}"`);
    });
  });
});
