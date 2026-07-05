/**
 * EasyPostcodes — UK postcode address lookup.
 *
 * https://easypostcodes.com/documentation — `GET /addresses/{postcode}` with
 * the API key in a `Key` header returns a JSON array of addresses; we keep
 * each one's ready-made `envelopeAddress.summaryLine`.
 */

import * as v from "valibot";
import { mapNotNullish } from "#fp";
import type { ApiResult } from "#shared/fetch.ts";
import { fetchText, parseApiError } from "#shared/fetch.ts";
import type {
  AddressLookupProviderDefinition,
  AddressLookupResult,
} from "./types.ts";

const API_BASE = "https://api.easypostcodes.com/addresses/";

/**
 * A UK postcode with the space removed: outward code (area letters + district
 * digit, optionally one more letter/digit) followed by the three-character
 * inward code (sector digit + two unit letters).
 */
const UK_POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

/**
 * Normalise a UK postcode: uppercase, drop everything but letters and digits,
 * then put the single space back before the three-character inward code.
 * Returns null for anything that isn't shaped like a UK postcode.
 */
export const normaliseUkPostcode = (raw: string): string | null => {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!UK_POSTCODE_REGEX.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
};

/** The one slice of each returned address we keep. */
const EasypostcodesResponseSchema = v.array(
  v.object({
    envelopeAddress: v.optional(v.object({ summaryLine: v.string() })),
  }),
);

/** Parse a response body into summary lines, or null when it isn't the
 * documented shape. */
export const parseEasypostcodesBody = (body: string): string[] | null => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = v.safeParse(EasypostcodesResponseSchema, json);
  if (!parsed.success) return null;
  return mapNotNullish(
    (entry: { envelopeAddress?: { summaryLine: string } }) =>
      entry.envelopeAddress?.summaryLine,
  )(parsed.output);
};

/** Look up a normalised postcode against the EasyPostcodes API. */
export const fetchEasypostcodesAddresses = async (
  search: string,
  apiKey: string,
): Promise<ApiResult<AddressLookupResult>> => {
  let response: Awaited<ReturnType<typeof fetchText>>;
  try {
    response = await fetchText(API_BASE + encodeURIComponent(search), {
      headers: { Key: apiKey },
    });
  } catch (error) {
    return { error: `EasyPostcodes lookup failed: ${String(error)}`, ok: false };
  }
  // An unknown-but-well-formed postcode is a normal "no matches" outcome, not
  // a provider failure — return (and cache) the empty list.
  if (response.status === 404) return { addresses: [], ok: true };
  if (!response.ok) return parseApiError(response, "EasyPostcodes lookup");
  const addresses = parseEasypostcodesBody(response.text);
  if (addresses === null) {
    return { error: "EasyPostcodes lookup returned an unexpected response", ok: false };
  }
  return { addresses, ok: true };
};

/** The EasyPostcodes provider definition. */
export const EASYPOSTCODES_PROVIDER: AddressLookupProviderDefinition = {
  fetchAddresses: fetchEasypostcodesAddresses,
  label: "EasyPostcodes",
  normaliseSearch: normaliseUkPostcode,
  searchLabelKey: "address_lookup.search.postcode",
  searchPlaceholderKey: "address_lookup.search.postcode_placeholder",
};
