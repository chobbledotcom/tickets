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
import { getGroupRemainingByListingId } from "#shared/db/attendees.ts";
import {
  getChildListingIds,
  getChildrenForParents,
} from "#shared/db/listing-parents.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { buildTicketListing, type TicketListing } from "#templates/public.tsx";

/**
 * How a discovery surface should treat each listing:
 * - `childIds` — listings that are a child of some parent; their standalone
 *   Book/Buy CTA (and feed/gallery/builder/share affordance) must be suppressed.
 * - `soldOutParentIds` — parents with no individually-bookable child; their card
 *   must render as sold out (and they must be omitted from feeds/gallery), since
 *   the booking gate would reject the order as sold out.
 */
export type DiscoveryClassification = {
  childIds: ReadonlySet<number>;
  soldOutParentIds: ReadonlySet<number>;
};

const EMPTY_CLASSIFICATION: DiscoveryClassification = {
  childIds: new Set(),
  soldOutParentIds: new Set(),
};

/** Whether a built child is individually bookable: active and neither sold out
 * nor closed. The single source of truth shared by discovery surfaces (which
 * build the {@link TicketListing} for a minimum single-day order) and the
 * booking page (which already has each child built for the resolved date). Hidden
 * children stay bookable — `hidden` governs the index, not eligibility
 * (parents.md, Edge cases); only `active` / sold-out / closed disqualify. */
const childBookable = (child: TicketListing): boolean =>
  child.listing.active && !child.isSoldOut && !child.isClosed;

/** A child is individually bookable on a discovery surface when it is active and
 * neither sold out nor registration-closed at the minimum (single-day) order. */
const childAvailableForDiscovery = (
  child: ListingWithCount,
  groupRemaining: number | undefined,
): boolean =>
  childBookable(
    buildTicketListing(child, isRegistrationClosed(child), groupRemaining),
  );

/**
 * Classify the given listings for a discovery surface (see
 * {@link DiscoveryClassification}). The empty classification is returned
 * (without any query) when the parents feature is off, so existing surfaces are
 * unchanged until the feature ships.
 *
 * `soldOutParentIds` contains a parent only when it has at least one child edge
 * and *none* of its children are individually bookable — a parent with no edges
 * at all is an ordinary listing and is never forced sold out here.
 */
export const classifyForDiscovery = async (
  listings: readonly ListingWithCount[],
): Promise<DiscoveryClassification> => {
  // The relationship accessors below already no-op (no query) on an empty id
  // list, so the only short-circuit needed is the feature flag.
  if (!isListingParentsEnabled()) return EMPTY_CLASSIFICATION;
  const ids = listings.map((l) => l.id);
  const [childIds, childrenByParent] = await Promise.all([
    getChildListingIds(ids),
    getChildrenForParents(ids),
  ]);
  const everyChild = [...childrenByParent.values()].flat();
  const groupRemaining = await getGroupRemainingByListingId(everyChild);
  const soldOutParentIds = new Set<number>();
  for (const [parentId, children] of childrenByParent) {
    const anyBookable = children.some((child) =>
      childAvailableForDiscovery(child, groupRemaining.get(child.id)),
    );
    if (!anyBookable) soldOutParentIds.add(parentId);
  }
  return { childIds, soldOutParentIds };
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
 */
export const applyBookingPageParentSoldOut = (
  listings: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
): TicketListing[] =>
  listings.map((info) => {
    const children = childrenByParentId.get(info.listing.id);
    if (children && children.length > 0 && !children.some(childBookable)) {
      return asSoldOut(info);
    }
    return info;
  });
