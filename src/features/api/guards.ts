import { apiError } from "#routes/api/cors.ts";
import { LISTING_NOT_FOUND, withActiveListing } from "#routes/api/helpers.ts";
import { classifyForDiscovery } from "#routes/public/discovery.ts";
import type { ServerContext } from "#routes/types.ts";
import type { ListingWithCount } from "#types";

/** How a single listing should read on the detail/availability surfaces under
 * the parent/child feature: a child is not standalone-bookable (404, matching
 * how the web booking page rejects a child slug), and a parent with no bookable
 * child reads sold out / unavailable. */
type ListingDiscoveryState = { isChild: boolean; isSoldOutParent: boolean };

/** Classify one listing for the detail/availability endpoints, reusing the same
 * discovery classification the web surfaces use (child suppression + parent
 * sold-out). Flag-off (or a plain listing) yields the neutral state, so existing
 * endpoints are unchanged until parents ship. */
const listingDiscoveryState = async (
  listing: ListingWithCount,
): Promise<ListingDiscoveryState> => {
  const { nonStandaloneChildIds, soldOutParentIds } =
    await classifyForDiscovery([listing]);
  return {
    isChild: nonStandaloneChildIds.has(listing.id),
    isSoldOutParent: soldOutParentIds.has(listing.id),
  };
};

/** Guard the detail/availability endpoints against a child listing: returns a
 * 404 response when the listing is a child (not standalone-bookable), or
 * `{ isSoldOutParent }` to proceed. Shared by the detail and
 * availability handlers so the child-rejection logic is never duplicated. */
const guardChildListing = async (
  listing: ListingWithCount,
): Promise<{ isSoldOutParent: boolean } | Response> => {
  const { isChild, isSoldOutParent } = await listingDiscoveryState(listing);
  if (isChild) return apiError(LISTING_NOT_FOUND, 404);
  return { isSoldOutParent };
};

/** Combines withActiveListing and guardChildListing: resolves the listing by
 * slug, rejects child listings with a 404, then calls the
 * handler with the listing and its isSoldOutParent flag. */
export const withGuardedListing = (
  handler: (
    request: Request,
    listing: ListingWithCount,
    isSoldOutParent: boolean,
    server?: ServerContext,
  ) => Promise<Response>,
) =>
  withActiveListing(async (request, listing, server) => {
    const guard = await guardChildListing(listing);
    if (guard instanceof Response) return guard;
    return handler(request, listing, guard.isSoldOutParent, server);
  });
