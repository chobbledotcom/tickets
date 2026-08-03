import { t } from "#i18n";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
  providerCurrencyBlock,
} from "#shared/payment-providers.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { RadioOption } from "#templates/components/radio-option.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";

const ProviderOption = ({
  currency,
  id,
  selected,
}: {
  currency: string;
  id: PaymentProviderType;
  selected: boolean;
}): JSX.Element => {
  const currencyBlock = providerCurrencyBlock(id, currency);
  return (
    <RadioOption
      checked={selected}
      disabled={currencyBlock !== null}
      name="payment_provider"
      value={id}
    >
      {PAYMENT_PROVIDERS[id].label}
      {currencyBlock && <small class="notice">{currencyBlock}</small>}
    </RadioOption>
  );
};

export const PaymentProviderForm = (s: SettingsPageState): JSX.Element => (
  <SaveForm
    action="/admin/settings/payment-provider"
    id="settings-payment-provider"
    submitLabel={t("settings.save_payment_provider")}
  >
    <div class="prose">
      <h2>{t("settings.payment_provider")}</h2>
      <p>{t("settings.payment_provider_hint")}</p>
    </div>
    <fieldset class="radios">
      <RadioOption
        checked={!s.paymentProvider}
        name="payment_provider"
        value="none"
      >
        {t("settings.payment_none")}
      </RadioOption>
      {PAYMENT_PROVIDER_IDS.map((id) => (
        <ProviderOption
          currency={s.currency}
          id={id}
          selected={s.paymentProvider === id}
        />
      ))}
    </fieldset>
  </SaveForm>
);

export const ExistingPaymentProviderForm = (
  s: SettingsPageState,
): JSX.Element | null =>
  s.paymentProviderRecoveryChoices.length > 0 ? (
    <SaveForm
      action="/admin/settings/payment-provider-recovery"
      id="settings-payment-provider-recovery"
      submitLabel={t("settings.payment_recovery_save")}
    >
      <div class="prose">
        <h2>{t("settings.payment_recovery_heading")}</h2>
        <p>{t("settings.payment_recovery_hint")}</p>
      </div>
      <fieldset class="radios">
        {s.paymentProviderRecoveryChoices.map((provider) => (
          <RadioOption
            checked={false}
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
