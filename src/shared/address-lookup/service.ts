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

import { t } from "#i18n";
import {
  computeAddressSearchIndex,
  getCachedAddresses,
  storeCachedAddresses,
} from "#shared/db/address-cache.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { ADDRESS_LOOKUP_PROVIDERS } from "./providers.ts";
import type { AddressLookupProvider, AddressMatch } from "./types.ts";

/** Look up the addresses for a raw search, serving from cache when fresh. */
export const lookupAddresses = async (
  provider: AddressLookupProvider,
  rawSearch: string,
): Promise<Result<AddressMatch[]>> => {
  const definition = ADDRESS_LOOKUP_PROVIDERS[provider];
  const normalised = definition.normaliseSearch(rawSearch);
  if (normalised === null) {
    return errorResult(t("address_lookup.invalid_search"));
  }
  const searchIndex = await computeAddressSearchIndex(provider, normalised);
  const cached = await getCachedAddresses(searchIndex);
  if (cached !== null) return okResult(cached);
  const result = await definition.fetchAddresses(
    normalised,
    settings.addressLookup.apiKey,
  );
  if (!result.ok) {
    logError({ code: ErrorCode.ADDRESS_LOOKUP, detail: result.error });
    return errorResult(t("address_lookup.failed"));
  }
  await storeCachedAddresses(searchIndex, result.value);
  return okResult(result.value);
};
