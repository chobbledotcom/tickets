/**
 * Address lookup provider registry.
 *
 * One exhaustive `Record` over {@link AddressLookupProvider}: a new provider
 * added to the setting picklist fails to compile until its definition is
 * registered here.
 */

import { settings } from "#shared/db/settings.ts";
import { EASYPOSTCODES_PROVIDER } from "./easypostcodes.ts";
import type {
  AddressLookupProvider,
  AddressLookupProviderDefinition,
} from "./types.ts";

/** Every configurable lookup provider, keyed by its setting value. */
export const ADDRESS_LOOKUP_PROVIDERS: Record<
  AddressLookupProvider,
  AddressLookupProviderDefinition
> = {
  easypostcodes: EASYPOSTCODES_PROVIDER,
};

/** The configured provider, or null when address lookup is off ("none"). */
export const activeAddressLookupProvider = (): AddressLookupProvider | null => {
  const provider = settings.addressLookup.provider;
  return provider === "none" ? null : provider;
};
