/**
 * Shared "fetch a listing by id, then build something from it" loader.
 *
 * The entity page loader and the QR context loader both fetch a listing and
 * return null when it is gone, then assemble their own shape from the row. This
 * keeps that fetch-then-null-guard in one place.
 */

import { getListingWithCount } from "#db/listings/records.ts";
import { type FindByIdThen, findByIdThen } from "#shared/find-by-id.ts";
import type { ListingWithCount } from "#types";

/** Load the listing with the given id and build a value from it, or null when
 *  no such listing exists. */
export const loadListingOr: FindByIdThen<ListingWithCount> =
  findByIdThen(getListingWithCount);
