/**
 * Discovery/share-surface suppression for the listing parent/child feature.
 *
 * Every *discovery* surface (public listing cards, the order gallery, RSS/ICS
 * feeds, the admin multi-booking link builder, per-listing share/QR generators)
 * advertises a standalone `/ticket/<slug>` entry point. Because a booking can
 * never start from a child (invariant I3), a *visible* child must not advertise
 * such a link, and a parent whose required children are **all unavailable** must
 * read as sold out (invariant I6) — otherwise the surface publishes a link the
 * booking gate then rejects.
 *
 * This module is the single source of truth those surfaces share so they stay
 * consistent. Everything here is gated behind {@link isListingParentsEnabled}:
 * with the flag off it returns the empty classification (no queries), leaving
 * existing behaviour untouched until the feature ships.
 *
 * Availability note: discovery has no submitted date/duration, so child
 * bookability is evaluated at the minimum order (a single day) using the
 * card-level sold-out/closed state — "no child is individually bookable" ⇒
 * parent sold out. The full combined-group-demand refinement (a parent and its
 * auto-selected child sharing a capped group consume two spots) is the deeper
 * check described in parents.md ("the *combined* parent+child demand check");
 * the date-/duration-specific evaluation lives in the booking gate, which is the
 * authority that ultimately rejects an unbookable order. See parents.md, the
 * "Public listing cards" and "no bookable child ⇒ sold out" sections.
 */

import { isRegistrationClosed } from "#routes/format.ts";
import { isListingParentsEnabled } from "#shared/config.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { getGroupRemainingByListingId } from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getChildIdsWithActiveParent,
  getChildListingIds,
  getChildrenForParents,
} from "#shared/db/listing-parents.ts";
import type { Holiday, ListingWithCount } from "#shared/types.ts";
import { buildTicketListing, type TicketListing } from "#templates/public.tsx";

/**
 * How a discovery surface should treat each listing:
 * - `childIds` — **every** listing that is a child of some parent. A booking can
 *   never start from a child (invariant I3) — the slug guard rejects *all* child
 *   slugs regardless of parent.active — so a child's standalone Book/Buy CTA
 *   (and feed/gallery/builder/share affordance) must be suppressed in every
 *   case, matching what `getChildListingIds` rejects at the booking entry point.
 * - `addOnChildIds` — the subset of `childIds` that have at least one **active**
 *   parent. Such a child has a live parent page that can offer/fold it, so its
 *   card shows the "available as an add-on" note. A child in `childIds` but not
 *   here has *no* active parent page to be offered under, so the add-on note
 *   would point at nothing: it renders **unavailable** instead (parents.md,
 *   "Public listing cards").
 * - `soldOutParentIds` — parents with no bookable child (combined parent+child
 *   demand, invariant I7); their card must render as sold out (and they must be
 *   omitted from feeds/gallery), since the booking gate would reject the order.
 */
export type DiscoveryClassification = {
  childIds: ReadonlySet<number>;
  addOnChildIds: ReadonlySet<number>;
  soldOutParentIds: ReadonlySet<number>;
};

const EMPTY_CLASSIFICATION: DiscoveryClassification = {
  addOnChildIds: new Set(),
  childIds: new Set(),
  soldOutParentIds: new Set(),
};

/** Whether a built child is individually bookable at render (no submitted date):
 * active, not closed, and — for its capacity component — *potentially* bookable.
 *
 * The sold-out component splits by listing kind (Codex 63). `buildTicketListing`
 * computes `isSoldOut` from the date-LESS cumulative aggregate, which is only
 * meaningful for a STANDARD child (cumulative, date-independent capacity). For a
 * DAILY child it is wrong: a 1-capacity daily child booked on one date reads
 * `isSoldOut=true` and would globalise that one full date into "sold out for
 * EVERY date", forcing its parent's card/page sold out on dates the child still
 * has room for. So a daily child is "potentially bookable" at render whenever it
 * is active, not closed, and has at least one bookable start date on its own
 * calendar; its true per-date capacity is the authoritative submit-side fold's
 * job (it rejects — never clamps — a genuinely full date). Hidden children stay
 * bookable — `hidden` governs the index, not eligibility (parents.md, Edge
 * cases). */
const childBookable = (child: TicketListing, holidays: Holiday[]): boolean => {
  if (!child.listing.active || child.isClosed) return false;
  return child.listing.listing_type === "daily"
    ? getBookableStartDates(child.listing, holidays).length > 0
    : !child.isSoldOut;
};

/**
 * Whether the *combined* minimum order — one parent plus one of this child —
 * fits the capacity they share (invariant I7, parents.md "combined parent+child
 * demand"). When the parent and child sit in the **same capped group** they
 * consume **two** group spots per order, so a single remaining spot is not
 * enough even though each row looks individually bookable; that needs ≥2
 * remaining. `childGroupRemaining` is the child's group-remaining entry (only
 * present for a capped group), which equals the shared group's remaining when
 * parent and child are co-grouped. When they are in different/uncapped groups
 * the per-row check already stands, so the combined demand always fits. */
const combinedDemandFits = (
  parent: ListingWithCount,
  child: ListingWithCount,
  childGroupRemaining: number | undefined,
): boolean => {
  const sharedCappedGroup =
    parent.group_id === child.group_id && childGroupRemaining !== undefined;
  return !sharedCappedGroup || childGroupRemaining >= 2;
};

/** Whether a child counts as bookable *for a given parent* on a discovery
 * surface: it must be individually bookable (active, not sold out/closed at the
 * minimum single-day order) AND the combined parent+child demand must fit the
 * shared group capacity (invariant I7). */
const childBookableForParent = (
  parent: ListingWithCount,
  child: ListingWithCount,
  groupRemaining: number | undefined,
  holidays: Holiday[],
): boolean =>
  childBookable(
    buildTicketListing(child, isRegistrationClosed(child), groupRemaining),
    holidays,
  ) && combinedDemandFits(parent, child, groupRemaining);

/**
 * Classify the given listings for a discovery surface (see
 * {@link DiscoveryClassification}). The empty classification is returned
 * (without any query) when the parents feature is off, so existing surfaces are
 * unchanged until the feature ships.
 *
 * `soldOutParentIds` contains a parent only when it has at least one child edge
 * and *none* of its children are bookable for the combined parent+child demand
 * (invariant I7) — a parent with no edges at all is an ordinary listing and is
 * never forced sold out here.
 */
export const classifyForDiscovery = async (
  listings: readonly ListingWithCount[],
): Promise<DiscoveryClassification> => {
  // The relationship accessors below already no-op (no query) on an empty id
  // list, so the only short-circuit needed is the feature flag.
  if (!isListingParentsEnabled()) return EMPTY_CLASSIFICATION;
  const ids = listings.map((l) => l.id);
  const [childIds, addOnChildIds, childrenByParent] = await Promise.all([
    getChildListingIds(ids),
    getChildIdsWithActiveParent(ids),
    getChildrenForParents(ids),
  ]);
  const byId = new Map(listings.map((l) => [l.id, l]));
  const everyChild = [...childrenByParent.values()].flat();
  const [groupRemaining, holidays] = await Promise.all([
    getGroupRemainingByListingId(everyChild),
    getActiveHolidays(),
  ]);
  const soldOutParentIds = new Set<number>();
  for (const [parentId, children] of childrenByParent) {
    const parent = byId.get(parentId);
    const anyBookable =
      parent !== undefined &&
      children.some((child) =>
        childBookableForParent(
          parent,
          child,
          groupRemaining.get(child.id),
          holidays,
        ),
      );
    if (!anyBookable) soldOutParentIds.add(parentId);
  }
  return { addOnChildIds, childIds, soldOutParentIds };
};

/** Force a {@link TicketListing} into the sold-out state (no Book CTA, no
 * purchasable quantity) — used to project a parent with no bookable child onto
 * the card/gallery state the booking gate will enforce. */
const asSoldOut = (info: TicketListing): TicketListing => ({
  ...info,
  isSoldOut: true,
  maxPurchasable: 0,
});

/** Apply the parent-sold-out classification to a list of {@link TicketListing}
 * (children are still returned — the public cards keep the child's card and only
 * suppress its standalone CTA). A parent with no bookable child is projected to
 * the sold-out state so its card reads sold out. */
export const applyParentSoldOut = (
  listings: readonly TicketListing[],
  { soldOutParentIds }: DiscoveryClassification,
): TicketListing[] =>
  listings.map((info) =>
    soldOutParentIds.has(info.listing.id) ? asSoldOut(info) : info,
  );

/**
 * Project the booking page's own listings to sold-out for any parent whose
 * children are ALL unavailable (invariant I6), reusing the children the page
 * already built (`childrenByParentId`) rather than re-querying. Mirrors the
 * discovery/feed behaviour on `/ticket/<parent>` so a parent with no bookable
 * child renders sold out (no quantity selector / Book control) instead of a
 * normal form that could only fail with the child-sold-out error at submit
 * (Codex 914). A listing with no child edge is left untouched; the authoritative
 * date-specific rejection still happens in the fold at submit.
 *
 * `groupRemainingByListingId` carries each child's shared group-remaining entry
 * so the bookability test uses the *combined* parent+child demand (invariant
 * I7): a parent and its child in the same capped group consume two group spots,
 * so a parent with a single remaining group spot reads sold out here too —
 * matching what the submit-time `checkBatchAvailability` would reject.
 *
 * `holidays` lets a daily child's render-time bookability be judged by its own
 * calendar rather than the date-less `isSoldOut` aggregate (Codex 63 — see
 * {@link childBookable}), so a daily child full on one date doesn't force its
 * parent's page sold out for every date.
 */
export const applyBookingPageParentSoldOut = (
  listings: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
  groupRemainingByListingId: ReadonlyMap<number, number>,
  holidays: Holiday[],
): TicketListing[] =>
  listings.map((info) => {
    const children = childrenByParentId.get(info.listing.id);
    const anyBookable = children?.some((child) =>
      childBookableForParent(
        info.listing,
        child.listing,
        groupRemainingByListingId.get(child.listing.id),
        holidays,
      ),
    );
    if (children && children.length > 0 && !anyBookable) {
      return asSoldOut(info);
    }
    return info;
  });
