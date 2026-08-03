import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
} from "#shared/payment-providers.ts";
import { PaymentProviderForm } from "#templates/admin/settings/payment.tsx";
import { ExistingPaymentProviderForm } from "#templates/admin/settings/payment-provider.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { defaultSettingsState } from "#test/ui/templates/admin/settings-state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";

const render = (
  form: (s: SettingsPageState) => JSX.Element | null,
  overrides: Partial<SettingsPageState> = {},
): string => String(form({ ...defaultSettingsState(), ...overrides }) ?? "");

const inputForValue = (html: string, value: string): string =>
  html.match(new RegExp(`<input\\b[^>]*value="${value}"[^>]*>`))?.[0] ?? "";

describe("settings payment provider forms", () => {
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

  describe("ExistingPaymentProviderForm", () => {
    test("requires an explicit configured provider while sales stay off", () => {
      const html = render(ExistingPaymentProviderForm, {
        existingPaymentProvider: null,
        paymentProvider: null,
        paymentProviderRecoveryChoices: ["stripe", "square"],
      });
      expect(html).toContain(
        'action="/admin/settings/payment-provider-recovery"',
      );
      expect(html).toContain('id="settings-payment-provider-recovery"');
      expect(html).toContain('<div class="prose">');
      expect(html).toContain('<fieldset class="radios">');
      for (const provider of ["stripe", "square"]) {
        const input = inputForValue(html, provider);
        expect(input).toContain('name="existing_payment_provider"');
        expect(input).toContain("required");
        expect(input).not.toContain("checked");
      }
      expect(html).toContain("New sales will stay off.");
    });

    test("shows the recovery form for one configured provider", () => {
      const html = render(ExistingPaymentProviderForm, {
        paymentProviderRecoveryChoices: ["sumup"],
      });
      expect(inputForValue(html, "sumup")).toContain(
        'name="existing_payment_provider"',
      );
    });

    test("keeps the submitted provider selected after an error", () => {
      setSavedFormData(new FormParams("existing_payment_provider=square"));
      const html = render(ExistingPaymentProviderForm, {
        paymentProviderRecoveryChoices: ["stripe", "square"],
      });

      expect(hasCheckedInput(html, "existing_payment_provider", "square")).toBe(
        true,
      );
      expect(hasCheckedInput(html, "existing_payment_provider", "stripe")).toBe(
        false,
      );
    });

    test("stays hidden when no recovery choice is needed", () => {
      expect(render(ExistingPaymentProviderForm)).toBe("");
    });
  });
});
