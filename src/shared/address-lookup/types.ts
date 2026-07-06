/**
 * Address lookup — the provider-setting schema and the shared provider
 * interface.
 *
 * The owner picks a lookup provider in advanced settings; "none" turns the
 * feature off. Every real provider implements the same
 * {@link AddressLookupProviderDefinition}, and every dispatcher is an
 * exhaustive `Record` over {@link AddressLookupProvider} — so adding a
 * provider is one picklist entry plus one definition, and a missing
 * definition is a compile error rather than a silent fallthrough.
 *
 * This module is pure: definitions carry i18n keys, not rendered copy, and
 * the fetch functions receive their API key as an argument.
 */

import * as v from "valibot";
import type { ApiResult } from "#shared/fetch.ts";

/** Schema for the stored provider setting ("none" disables lookups). */
export const AddressLookupSettingSchema = v.picklist(["none", "easypostcodes"]);

/** The stored provider setting. */
export type AddressLookupSetting = v.InferOutput<
  typeof AddressLookupSettingSchema
>;

/** All valid provider-setting values (runtime array matching the union). */
export const ADDRESS_LOOKUP_SETTINGS = AddressLookupSettingSchema.options;

/** Type guard: check if an arbitrary string is a valid provider setting. */
export const isAddressLookupSetting = (s: string): s is AddressLookupSetting =>
  v.is(AddressLookupSettingSchema, s);

/** A provider that can actually search — every setting except "none". */
export type AddressLookupProvider = Exclude<AddressLookupSetting, "none">;

/** One matching address: its ready-to-display line, plus the provider's
 * latitude/longitude when it knows them ("" when it doesn't). */
export type AddressMatch = { line: string; lat: string; lng: string };

/** A successful search: one match per address the provider found. */
export type AddressLookupResult = { addresses: AddressMatch[] };

/** Everything one lookup provider knows how to do. */
export type AddressLookupProviderDefinition = {
  /** Provider name shown in the settings picklist (a brand, not translated). */
  label: string;
  /** i18n key for the search box label (e.g. "Postcode"). */
  searchLabelKey: string;
  /**
   * Normalise a raw search to the provider's canonical form for its locale
   * (e.g. UK postcodes: uppercase, one space before the last three
   * characters). Returns null when the search can never match, so the caller
   * can report that without spending a provider request.
   */
  normaliseSearch: (raw: string) => string | null;
  /** Fetch the addresses for a normalised search from the provider's API. */
  fetchAddresses: (
    search: string,
    apiKey: string,
  ) => Promise<ApiResult<AddressLookupResult>>;
};
