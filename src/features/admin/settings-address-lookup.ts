/**
 * Admin address-lookup settings route. Owner-only (via settingsHandler).
 *
 * Saves the lookup provider choice and its API key. The key is a masked
 * secret: a submitted sentinel leaves the stored value unchanged, an empty
 * value clears it. Selecting a real provider requires a key (stored or
 * provided in the same submission), so the search boxes can never appear
 * with a provider that has no credentials.
 */

import {
  processSecretField,
  type SecretFieldResult,
  saveSecret,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
import {
  type AddressLookupSetting,
  isAddressLookupSetting,
} from "#shared/address-lookup/types.ts";
import { settings } from "#shared/db/settings.ts";

type AddressLookupFormData = {
  provider: string;
  apiKey: SecretFieldResult;
};

/** Would this submission leave no API key stored? */
const clearsStoredKey = (apiKey: SecretFieldResult): boolean =>
  apiKey.action === "cleared" ||
  (apiKey.action === "unchanged" && !settings.addressLookup.hasKey);

export const handleAddressLookupPost = settingsHandler<AddressLookupFormData>({
  advanced: true,
  extract: (form) => ({
    apiKey: processSecretField(form, "address_lookup_api_key"),
    provider: form.getString("address_lookup_provider"),
  }),
  formId: "settings-address-lookup",
  label: "Address lookup settings",
  save: async ({ provider, apiKey }) => {
    // validate() already rejected anything outside the picklist.
    await settings.update.addressLookup.provider(
      provider as AddressLookupSetting,
    );
    await saveSecret(apiKey, settings.update.addressLookup.apiKey, {
      clearable: true,
    });
  },
  validate: ({ provider, apiKey }) => {
    if (!isAddressLookupSetting(provider)) {
      return "Unknown address lookup provider";
    }
    if (provider !== "none" && clearsStoredKey(apiKey)) {
      return "An API key is required to enable address lookup";
    }
    return null;
  },
});
