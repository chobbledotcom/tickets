/**
 * Latitude/longitude pair validation for the operator-pinned attendee
 * location (the Logistics tab's map pin).
 *
 * Coordinates stay the strings the operator (or the lookup provider) typed,
 * so a saved pin re-renders exactly as entered; this module only checks that
 * a submitted pair really is a location. This module is pure.
 */

import * as v from "valibot";

/** A plain decimal number, e.g. "57.14774" or "-2.096323". */
const DECIMAL_REGEX = /^-?\d+(\.\d+)?$/;

/** A coordinate string whose magnitude stays within `limit` degrees. */
const coordinateSchema = (limit: number) =>
  v.pipe(
    v.string(),
    v.regex(DECIMAL_REGEX),
    v.check((value: string) => Math.abs(Number(value)) <= limit),
  );

const LatitudeSchema = coordinateSchema(90);
const LongitudeSchema = coordinateSchema(180);

/** A pinned location, or the unpinned pair ("" for both). */
export type CoordinatePair = { lat: string; lng: string };

/** What parsing a submitted pair produced. */
export type CoordinatePairParse =
  | { ok: true; pin: CoordinatePair }
  | { ok: false };

/**
 * Parse a submitted lat/lng pair: both blank means "no pin", both valid means
 * a pin (trimmed, otherwise as entered), and anything else — half a pair, a
 * non-number, an out-of-range value — fails.
 */
export const parseCoordinatePair = (
  rawLat: string,
  rawLng: string,
): CoordinatePairParse => {
  const lat = rawLat.trim();
  const lng = rawLng.trim();
  if (lat === "" && lng === "") return { ok: true, pin: { lat: "", lng: "" } };
  if (
    !v.safeParse(LatitudeSchema, lat).success ||
    !v.safeParse(LongitudeSchema, lng).success
  ) {
    return { ok: false };
  }
  return { ok: true, pin: { lat, lng } };
};
