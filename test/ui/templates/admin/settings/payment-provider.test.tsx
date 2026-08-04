import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import { ExistingPaymentProviderForm } from "#templates/admin/settings/payment-provider.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { defaultSettingsState } from "#test/ui/templates/admin/settings-state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasCheckedInput, inputTagWithValue } from "#test-utils/csrf.ts";

const render = (
  form: (s: SettingsPageState) => JSX.Element | null,
  overrides: Partial<SettingsPageState> = {},
): string => String(form({ ...defaultSettingsState(), ...overrides }) ?? "");

describe("settings payment provider forms", () => {
  beforeAll(setupAdminPageTest);

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
        const input = inputTagWithValue(html, provider);
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
      expect(inputTagWithValue(html, "sumup")).toContain(
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
