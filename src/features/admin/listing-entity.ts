/**
 * The one id route handler that loads a listing with its counts, and the form
 * route that runs a command on it. Each admin route applies its own gate to
 * this shared loader, so the loader is written once (see "Keep methods flat"
 * in AGENTS.md).
 */

import { getListingWithCount } from "#db/listings/records.ts";
import type { FormGuard } from "#routes/admin/confirmation.ts";
import type { AuthSession } from "#routes/auth.ts";
import {
  createIdEntityHandler,
  type EntityHandler,
  type IdParam,
  type IdRouteHandler,
} from "#routes/entity.ts";
import type { ListingWithCount } from "#types";

/** Load one listing with its counts for an id route, behind the caller's gate. */
export const listingWithCountHandler: EntityHandler<IdParam, ListingWithCount> =
  createIdEntityHandler<ListingWithCount>(getListingWithCount);

/** A command on one listing: the loaded listing, its id, and the answer to
 * send. */
export type ListingCommand = (
  listing: ListingWithCount,
  id: number,
) => Promise<Response>;

/** A form POST on one listing: the gate runs, the listing loads with its
 * counts, and the command answers the request. */
export const listingFormRoute = (
  guard: FormGuard<AuthSession>,
  command: ListingCommand,
): IdRouteHandler =>
  listingWithCountHandler(guard)((listing, _session, _form, _request, { id }) =>
    command(listing, id),
  );
