import { filter, pipe } from "#fp";
import { apiResponse } from "#routes/api/cors.ts";
import { withGuardedListing } from "#routes/api/guards.ts";
import {
  buildChildPublicListings,
  mapParentChildren,
  toPublicListing,
  toResolvedPublicListing,
} from "#routes/api/public-listing.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import {
  classifyForDiscovery,
  dropHiddenPackageMembers,
  loadBookablePackages,
} from "#routes/public/discovery.ts";
import { keepParentDailyDatesChildrenCanServe } from "#routes/public/ticket-payment.ts";
import { capacityDateFor } from "#shared/capacity-rules.ts";
import { getAvailableDates, getBookableStartDates } from "#shared/dates.ts";
import { getGroupRemainingByListingId } from "#shared/db/attendees/capacity.ts";
import { hasAvailableSpots } from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { sortListings } from "#shared/sort-listings.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";

/** GET /api/listings — list active, non-hidden listings */
export const handleListListings = async (): Promise<Response> => {
  const allListings = await getAllListings();
  const holidays = await getActiveHolidays();
  const visibleListings = pipe(
    filter((e: ListingWithCount) => e.active && !e.hidden),
    (active) => sortListings(active, holidays),
  )(allListings);
  // A child is never standalone-bookable, so omit children from
  // the discovery list — a client must not find one here and then hit the
  // booking 400. A parent with no
  // bookable child is sold out: its OWN row capacity ignores its
  // children, so the list must project it to sold-out / not-bookable to stay
  // consistent with the detail/availability endpoints — otherwise a
  // client lists it as bookable then hits the parent-sold-out outcome at detail.
  const { nonStandaloneChildIds, soldOutParentIds } =
    await classifyForDiscovery(visibleListings);
  // Drop the members of a HIDDEN package too: they have no standalone page (their
  // /ticket slug 404s), so the API must not list them as bookable either. A
  // `bookable_alone` child is NOT dropped — it keeps its own catalog entry.
  const bookableListings = await dropHiddenPackageMembers(
    visibleListings.filter((e) => !nonStandaloneChildIds.has(e.id)),
  );
  const groupRemaining = await getGroupRemainingByListingId(bookableListings);
  const listings = bookableListings.map((e) => {
    const publicListing = toPublicListing(
      e,
      isRegistrationClosed(e),
      undefined,
      groupRemaining.get(e.id),
    );
    return soldOutParentIds.has(e.id)
      ? { ...publicListing, isSoldOut: true, maxPurchasable: 0 }
      : publicListing;
  });
  // Packages are first-class products: a bookable package bundle is listed by
  // name/slug (booked whole at /ticket/<group-slug>), so a hidden package stays
  // discoverable even though its member listings are dropped above.
  const packages = (await loadBookablePackages()).map((g) => ({
    description: g.description,
    name: g.name,
    slug: g.slug,
    url: `/ticket/${g.slug}`,
  }));
  return apiResponse({ listings, packages });
};

/** GET /api/listings/:slug — single listing detail */
export const handleGetListing = withGuardedListing(
  async (_request, listing, isSoldOutParent) => {
    let availableDates: string[] | undefined;
    if (listing.listing_type === "daily") {
      const holidays = await getActiveHolidays();
      // A daily parent's API dates must match what the web selector offers: a date
      // no required child can serve (for the inherited span) is removed from the
      // parent's own calendar, so the API never advertises a date the fold rejects
      // For a non-parent daily listing this is a no-op.
      availableDates = await keepParentDailyDatesChildrenCanServe(
        listing,
        getAvailableDates(listing, holidays),
        holidays,
      );
    }
    const [publicListing, children] = await Promise.all([
      toResolvedPublicListing(listing, availableDates),
      buildChildPublicListings(listing),
    ]);
    // A parent advertises its required children so a client can choose a valid one
    // (slug, price, inputs, dates) before the booking POST.
    const withChildren =
      children.length > 0 ? { ...publicListing, children } : publicListing;
    // A parent with no bookable child is sold out; the route
    // listing's own capacity ignores its children, so project the discovery
    // sold-out outcome onto the response rather than advertising it as bookable.
    return apiResponse({
      listing: isSoldOutParent
        ? { ...withChildren, isSoldOut: true, maxPurchasable: 0 }
        : withChildren,
    });
  },
);

/** Per-child availability for a parent's required children at a date/quantity, or
 * null when the listing is not a parent. A daily child takes the parent's date;
 * a standard child is date-less. An inactive (`active=0`) or registration-closed
 * child reports `available: false` regardless of spare capacity: the
 * booking fold rejects it (`childActive`/`childOpen` in shared.tsx), so reusing
 * the same `active` + `isRegistrationClosed` predicates the fold uses keeps the
 * availability endpoint from advertising a child the booking POST would refuse. */
const buildChildAvailability = (
  parent: ListingWithCount,
  date: string | undefined,
  quantity: number,
): Promise<{ slug: string; available: boolean }[] | null> => {
  return mapParentChildren(parent, async (child) => {
    let childDateAvail = true;
    if (child.listing_type === "daily" && date) {
      childDateAvail = getBookableStartDates(
        child,
        await getActiveHolidays(),
      ).includes(date);
    }
    return {
      available:
        child.active &&
        !isRegistrationClosed(child) &&
        childDateAvail &&
        (await hasAvailableSpots(
          child.id,
          quantity,
          capacityDateFor(child.listing_type, date),
          child.duration_days,
        )),
      slug: child.slug,
    };
  });
};

/** GET /api/listings/:slug/availability — check if spots are available */
export const handleCheckAvailability = withGuardedListing(
  async (request, listing, isSoldOutParent) => {
    // A parent with no bookable child is sold out: its own capacity
    // ignores its children, so report it unavailable rather than letting the
    // route listing's standalone spots advertise it as bookable.
    if (isSoldOutParent) return apiResponse({ available: false });
    const url = new URL(request.url);
    const quantity =
      parseNonNegativeInt(url.searchParams.get("quantity") ?? "1") ?? 1;
    const date = url.searchParams.get("date") || undefined;
    // A daily parent is available only on dates its required children can serve.
    // A daily listing with no children is returned unchanged by the helper.
    if (listing.listing_type === "daily" && date) {
      const holidays = await getActiveHolidays();
      const childServableDates = await keepParentDailyDatesChildrenCanServe(
        listing,
        getAvailableDates(listing, holidays),
        holidays,
      );
      if (!childServableDates.includes(date)) {
        return apiResponse({ available: false });
      }
    }
    const available = await hasAvailableSpots(
      listing.id,
      quantity,
      date,
      listing.duration_days,
    );
    // For a parent, also report each required child's availability for the chosen
    // date/quantity (a daily child inherits the parent's date; a standard child is
    // date-less), so a client can pick a child that can actually serve the booking
    // rather than discovering it only when the booking POST rejects it.
    const childAvailability = await buildChildAvailability(
      listing,
      date,
      quantity,
    );
    return apiResponse(
      childAvailability === null
        ? { available }
        : { available, children: childAvailability },
    );
  },
);
