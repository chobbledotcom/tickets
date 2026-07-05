/**
 * Address lookup form for advanced settings — provider picklist + API key.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { ADDRESS_LOOKUP_PROVIDERS } from "#shared/address-lookup/providers.ts";
import {
  ADDRESS_LOOKUP_SETTINGS,
  type AddressLookupSetting,
} from "#shared/address-lookup/types.ts";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";

/* jscpd:ignore-end */

/** Picklist label: "none" is translated copy, real providers show their brand. */
const providerLabel = (provider: AddressLookupSetting): string =>
  provider === "none"
    ? t("address_lookup.settings.provider_none")
    : ADDRESS_LOOKUP_PROVIDERS[provider].label;

export const AddressLookupForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <SettingsSection
    action="/admin/settings/address-lookup"
    description={<Raw html={t("address_lookup.settings.description")} />}
    submitLabel={t("address_lookup.settings.save")}
    title={t("address_lookup.settings.title")}
  >
    <label>
      {t("address_lookup.settings.provider")}
      <select name="address_lookup_provider">
        {ADDRESS_LOOKUP_SETTINGS.map((provider) => (
          <option
            selected={s.addressLookupProvider === provider}
            value={provider}
          >
            {providerLabel(provider)}
          </option>
        ))}
      </select>
    </label>
    <TextField
      label={t("address_lookup.settings.api_key")}
      name="address_lookup_api_key"
      placeholder={t("address_lookup.settings.api_key_placeholder")}
      type="password"
      value={s.addressLookupApiKeyConfigured ? MASK_SENTINEL : undefined}
    />
  </SettingsSection>
);
