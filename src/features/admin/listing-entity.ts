/**
 * The one id route handler that loads a listing with its counts. Each admin
 * route applies its own gate to this shared loader, so the loader is written
 * once (see "Keep methods flat" in AGENTS.md).
 */

import { getListingWithCount } from "#db/listings/records.ts";
import {
  createIdEntityHandler,
  type EntityHandler,
  type IdParam,
} from "#routes/entity.ts";
import type { ListingWithCount } from "#types";

/** Load one listing with its counts for an id route, behind the caller's gate. */
export const listingWithCountHandler: EntityHandler<IdParam, ListingWithCount> =
  createIdEntityHandler<ListingWithCount>(getListingWithCount);
