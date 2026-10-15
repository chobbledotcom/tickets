import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import { ExistingPaymentProviderForm } from "#templates/admin/settings/payment-provider.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { defaultSettingsState } from "#test/ui/templates/admin/settings-state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasCheckedInput, inputTagWithValue } from "#test-utils/csrf.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { says } from "#test-utils/says.ts";

const render = (
  form: (s: SettingsPageState) => JSX.Element | null,
  overrides: Partial<SettingsPageState> = {},
): string => String(form({ ...defaultSettingsState(), ...overrides }) ?? "");

describe("settings payment provider forms", () => {
  beforeAll(setupAdminPageTest);

  describe("ExistingPaymentProviderForm", () => {
    test("requires an explicit configured provider while sales stay off", () => {
      const html = render(ExistingPaymentProviderForm, {
        paymentProvider: null,
        paymentProviderRecoveryChoices: ["stripe", "square"],
      });
      says(html, 'action="/admin/settings/payment-provider-recovery"');
      says(html, 'id="settings-payment-provider-recovery"');
      says(html, '<div class="prose">');
      says(html, '<fieldset class="radios">');
      for (const provider of ["stripe", "square"]) {
        const input = inputTagWithValue(html, provider);
        says(input, 'name="existing_payment_provider"');
        says(input, "required");
        assert(!input.includes("checked"));
      }
      says(html, "New sales will stay off.");
    });

    test("shows the recovery form for one configured provider", () => {
      const html = render(ExistingPaymentProviderForm, {
        paymentProviderRecoveryChoices: ["sumup"],
      });
      says(
        inputTagWithValue(html, "sumup"),
        'name="existing_payment_provider"',
      );
    });

    test("keeps the submitted provider selected after an error", async () => {
      await withRequestContext(() => {
        setSavedFormData(new FormParams("existing_payment_provider=square"));
        const html = render(ExistingPaymentProviderForm, {
          paymentProviderRecoveryChoices: ["stripe", "square"],
        });

        expect(
          hasCheckedInput(html, "existing_payment_provider", "square"),
        ).toBe(true);
        expect(
          hasCheckedInput(html, "existing_payment_provider", "stripe"),
        ).toBe(false);
      });
    });

    test("stays hidden when no recovery choice is needed", () => {
      expect(render(ExistingPaymentProviderForm)).toBe("");
    });
  });
});
