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
import type { AddressLookupProviderDefinition } from "#shared/address-lookup/types.ts";

/**
 * Pull a search value out of an existing address so the box starts pre-filled.
 * When the address ends with ", <valid postcode>" (as saved addresses do), the
 * trailing postcode is offered to the search box; otherwise "".
 */
const initialSearchFrom = (
  definition: AddressLookupProviderDefinition,
  address: string,
): string => {
  const idx = address.lastIndexOf(", ");
  if (idx === -1) return "";
  return definition.normaliseSearch(address.slice(idx + 2)) ?? "";
};

/**
 * The search panel markup, or "" when no lookup provider is configured.
 *
 * `address` pre-fills the search box from an existing saved address (its
 * trailing postcode), so editing an attendee starts ready to re-search.
 */
export const renderAddressLookupPanel = (address = ""): string => {
  const provider = activeAddressLookupProvider();
  if (!provider) return "";
  const definition = ADDRESS_LOOKUP_PROVIDERS[provider];
  const initialSearch = initialSearchFrom(definition, address);
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
            type="text"
            value={initialSearch || undefined}
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
