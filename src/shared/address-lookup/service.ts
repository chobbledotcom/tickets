/**
 * Address lookup service — the IO shell around the provider definitions.
 *
 * One lookup is: normalise the search per the provider's rules → check the
 * encrypted address_cache by HMAC blind index → on a miss, fetch from the
 * provider with the stored API key and cache what came back. Provider
 * failures are logged with their detail but reported to the caller as a
 * generic translated message, so upstream error bodies never reach the
 * public form.
 */

import {
  computeAddressSearchIndex,
  getCachedAddresses,
  storeCachedAddresses,
} from "#shared/db/address-cache.ts";
import { settings } from "#shared/db/settings.ts";
import { t } from "#i18n";
import { ErrorCode, logError } from "#shared/logger.ts";
import { ADDRESS_LOOKUP_PROVIDERS } from "./providers.ts";
import type { AddressLookupProvider } from "./types.ts";

/** What a lookup reports back to the HTTP route. */
export type AddressLookupOutcome =
  | { ok: true; addresses: string[] }
  | { ok: false; error: string };

/** Look up the addresses for a raw search, serving from cache when fresh. */
export const lookupAddresses = async (
  provider: AddressLookupProvider,
  rawSearch: string,
): Promise<AddressLookupOutcome> => {
  const definition = ADDRESS_LOOKUP_PROVIDERS[provider];
  const normalised = definition.normaliseSearch(rawSearch);
  if (normalised === null) {
    return { error: t("address_lookup.invalid_search"), ok: false };
  }
  const searchIndex = await computeAddressSearchIndex(provider, normalised);
  const cached = await getCachedAddresses(searchIndex);
  if (cached !== null) return { addresses: cached, ok: true };
  const result = await definition.fetchAddresses(
    normalised,
    settings.addressLookup.apiKey,
  );
  if (!result.ok) {
    logError({ code: ErrorCode.ADDRESS_LOOKUP, detail: result.error });
    return { error: t("address_lookup.failed"), ok: false };
  }
  await storeCachedAddresses(searchIndex, result.addresses);
  return { addresses: result.addresses, ok: true };
};
