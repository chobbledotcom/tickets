/**
 * Address lookup search panel — the postcode search UI that sits directly
 * above an address textarea.
 *
 * Rendered `hidden` and only revealed by the address-lookup client script, so
 * a browser without JavaScript sees the plain textarea unchanged. All copy is
 * rendered here (translated server-side); the script reads its status
 * messages from the panel's data attributes and never carries strings of its
 * own.
 *
 * The address textarea always stays editable — searching a postcode fills it
 * in, but the customer can type or correct it at any point.
 */

import { t } from "#i18n";
import {
  ADDRESS_LOOKUP_PROVIDERS,
  activeAddressLookupProvider,
} from "#shared/address-lookup/providers.ts";

/** The search panel markup, or "" when no lookup provider is configured. */
export const renderAddressLookupPanel = (): string => {
  const provider = activeAddressLookupProvider();
  if (!provider) return "";
  const definition = ADDRESS_LOOKUP_PROVIDERS[provider];
  return String(
    <fieldset
      class="address-lookup"
      data-address-lookup={true}
      data-error={t("address_lookup.failed")}
      data-no-results={t("address_lookup.no_results")}
      data-placeholder={t("address_lookup.choose_placeholder")}
      data-searching={t("address_lookup.searching")}
      hidden
    >
      <div class="address-lookup-search">
        <label>
          {t(definition.searchLabelKey)}
          <input
            autocomplete="off"
            data-address-search={true}
            placeholder={t(definition.searchPlaceholderKey)}
            type="text"
          />
        </label>
        <button data-address-find={true} type="button">
          {t("address_lookup.find")}
        </button>
      </div>
      <label data-address-results-label={true} hidden>
        {t("address_lookup.choose")}
        <select data-address-results={true}></select>
      </label>
      <p data-address-status={true} hidden></p>
    </fieldset>,
  );
};
