import { t } from "#i18n";
import { savedFormValue } from "#shared/forms/saved-data.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { ProseIntro } from "#templates/components/prose-intro.tsx";
import { RadioOption } from "#templates/components/radio-option.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";

export const ExistingPaymentProviderForm = (
  s: SettingsPageState,
): JSX.Element | null =>
  s.paymentProviderRecoveryChoices.length > 0 ? (
    <SaveForm
      action="/admin/settings/payment-provider-recovery"
      id="settings-payment-provider-recovery"
      submitLabel={t("settings.payment_recovery_save")}
    >
      <ProseIntro
        heading={t("settings.payment_recovery_heading")}
        intro={t("settings.payment_recovery_hint")}
      />
      <fieldset class="radios">
        {s.paymentProviderRecoveryChoices.map((provider) => (
          <RadioOption
            checked={savedFormValue("existing_payment_provider") === provider}
            name="existing_payment_provider"
            required
            value={provider}
          >
            {PAYMENT_PROVIDERS[provider].label}
          </RadioOption>
        ))}
      </fieldset>
    </SaveForm>
  ) : null;
