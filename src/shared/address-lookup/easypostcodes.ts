/**
 * EasyPostcodes — UK postcode address lookup.
 *
 * https://easypostcodes.com/documentation — `GET /addresses/{postcode}` with
 * the API key in a `Key` header returns a JSON array of addresses; we keep
 * each one's ready-made `envelopeAddress.summaryLine` and its
 * `latitude`/`longitude` (used by the admin Logistics tab to pin a map).
 */

import * as v from "valibot";
import { mapNotNullish } from "#fp";
import { fetchText, parseApiError } from "#shared/fetch.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { AddressLookupProviderDefinition, AddressMatch } from "./types.ts";

const API_BASE = "https://api.easypostcodes.com/addresses/";

/** Ask for each address's coordinates too — without this flag the API omits
 * latitude/longitude entirely (they feed the Logistics tab's map pin). */
const GEO_QUERY = "?includeGeo=true";

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

/** The slice of each returned address we keep: the ready-made summary line
 * plus the coordinates (absent for ~0.03% of postcodes, e.g. brand-new ones). */
const EasypostcodesResponseSchema = v.array(
  v.object({
    envelopeAddress: v.optional(v.object({ summaryLine: v.string() })),
    latitude: v.optional(v.string()),
    longitude: v.optional(v.string()),
  }),
);

type EasypostcodesEntry = v.InferOutput<
  typeof EasypostcodesResponseSchema
>[number];

/** An entry's match, or undefined when it has no envelope address. A match
 * only carries coordinates when the entry has BOTH — half a location is no
 * location. */
const entryMatch = (entry: EasypostcodesEntry): AddressMatch | undefined => {
  const line = entry.envelopeAddress?.summaryLine;
  if (line === undefined) return;
  const located = Boolean(entry.latitude && entry.longitude);
  return {
    lat: located ? entry.latitude! : "",
    line,
    lng: located ? entry.longitude! : "",
  };
};

/** Parse a response body into address matches, or null when it isn't the
 * documented shape. */
export const parseEasypostcodesBody = (body: string): AddressMatch[] | null => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = v.safeParse(EasypostcodesResponseSchema, json);
  if (!parsed.success) return null;
  return mapNotNullish(entryMatch)(parsed.output);
};

/** Look up a normalised postcode against the EasyPostcodes API. */
export const fetchEasypostcodesAddresses = async (
  search: string,
  apiKey: string,
): Promise<Result<AddressMatch[]>> => {
  let response: Awaited<ReturnType<typeof fetchText>>;
  try {
    response = await fetchText(
      API_BASE + encodeURIComponent(search) + GEO_QUERY,
      { headers: { Key: apiKey } },
    );
  } catch (error) {
    return errorResult(`EasyPostcodes lookup failed: ${String(error)}`);
  }
  // An unknown-but-well-formed postcode is a normal "no matches" outcome, not
  // a provider failure — return (and cache) the empty list.
  if (response.status === 404) return okResult([]);
  if (!response.ok) return parseApiError(response, "EasyPostcodes lookup");
  const addresses = parseEasypostcodesBody(response.text);
  if (addresses === null) {
    return errorResult("EasyPostcodes lookup returned an unexpected response");
  }
  return okResult(addresses);
};

/** The EasyPostcodes provider definition. */
export const EASYPOSTCODES_PROVIDER: AddressLookupProviderDefinition = {
  fetchAddresses: fetchEasypostcodesAddresses,
  label: "EasyPostcodes",
  normaliseSearch: normaliseUkPostcode,
  searchLabelKey: "address_lookup.search.postcode",
};
