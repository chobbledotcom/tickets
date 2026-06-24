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
 * consistent.
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

import { mapNotNullish } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { getGroupRemainingByListingId } from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getChildListingIds,
  getChildrenForParents,
  getParentsForChildren,
} from "#shared/db/listing-parents.ts";
import type { Holiday, ListingWithCount } from "#shared/types.ts";
import {
  buildTicketListing,
  childActive,
  childCalendarOrInStockForSpan,
  childOpen,
  combinedGroupDemandFits,
  fixedParentSpan,
  selectableChild,
  type TicketListing,
} from "#templates/public.tsx";

/**
 * How a discovery surface should treat each listing:
 * - `childIds` — **every** listing that is a child of some parent. A booking can
 *   never start from a child (invariant I3) — the slug guard rejects *all* child
 *   slugs regardless of parent.active — so a child's standalone Book/Buy CTA
 *   (and feed/gallery/builder/share affordance) must be suppressed in every
 *   case, matching what `getChildListingIds` rejects at the booking entry point.
 * - `addOnChildIds` — the subset of `childIds` that have at least one
 *   **bookable** parent: a parent that is active AND not sold out AND not
 *   registration-closed (its own date-less row availability, matching the rest
 *   of discovery). Such a child has a live parent page that can actually offer
 *   and fold it, so its card shows the "available as an add-on" note. A child
 *   whose every parent is inactive, sold out, or closed has *no* parent page
 *   that can offer it (the parent page suppresses the child's own CTA/slug, a
 *   dead end), so the add-on note would point at nothing: it renders
 *   **unavailable** instead (parents.md, "Public listing cards", Fix 1).
 * - `soldOutParentIds` — parents with no bookable child (combined parent+child
 *   demand, invariant I7); their card must render as sold out (and they must be
 *   omitted from feeds/gallery), since the booking gate would reject the order.
 */
export type DiscoveryClassification = {
  childIds: ReadonlySet<number>;
  addOnChildIds: ReadonlySet<number>;
  soldOutParentIds: ReadonlySet<number>;
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
const childBookable = (
  child: TicketListing,
  holidays: Holiday[],
  parentFixedSpan: number | null,
  parentDates: ReadonlySet<string> | null,
): boolean =>
  selectableChild([
    childActive,
    childOpen,
    childCalendarOrInStockForSpan(holidays, parentFixedSpan, parentDates),
  ])(child);

/** Whether a *parent* can currently offer its children as add-ons (Fix 1): its
 * own row must be active AND not sold out AND not registration-closed. A parent
 * that is inactive, sold out, or closed cannot fold a child into a booking, so a
 * child whose only parents are all in this state has no live parent page to be
 * offered under — its "available as an add-on" note would be a dead end. The
 * sold-out/closed state is judged date-less (the parent's own row availability),
 * matching the rest of discovery. */
const parentBookable = (
  parent: ListingWithCount,
  groupRemaining: number | undefined,
): boolean => {
  if (!parent.active) return false;
  const info = buildTicketListing(
    parent,
    isRegistrationClosed(parent),
    groupRemaining,
  );
  return !info.isSoldOut && !info.isClosed;
};

/** A daily parent's own bookable start dates (the candidate dates its booking
 * page can offer), against which a daily child's calendar must overlap (Fix 5);
 * `null` for a non-daily parent, which has NO date selector — a daily child under
 * it inherits no parent date, so no overlap constraint applies (and the child is
 * judged by its own calendar / fixed span). */
const parentDatesOf = (
  parent: ListingWithCount,
  holidays: Holiday[],
): ReadonlySet<string> | null =>
  parent.listing_type === "daily"
    ? new Set(getBookableStartDates(parent, holidays))
    : null;

/** Whether a child counts as bookable *for a given parent* on a discovery
 * surface: it must be individually bookable (active, not sold out/closed at the
 * minimum single-day order), bookable on a date the PARENT can serve (Fix 5),
 * AND the combined parent+child demand must fit the shared group capacity
 * (invariant I7). */
const childBookableForParent = (
  parent: ListingWithCount,
  child: ListingWithCount,
  groupRemaining: number | undefined,
  holidays: Holiday[],
): boolean =>
  childBookable(
    buildTicketListing(child, isRegistrationClosed(child), groupRemaining),
    holidays,
    fixedParentSpan(parent),
    // A daily child must be bookable on a date the PARENT can actually serve, not
    // merely on its own calendar (Fix 5): otherwise disjoint weekdays leave the
    // parent advertised while `getTicketContext`'s date union renders no valid
    // date. A non-daily parent has no own date calendar — an empty set, which the
    // daily-only overlap test ignores for a (necessarily standard) child.
    parentDatesOf(parent, holidays),
  ) && combinedGroupDemandFits(parent.group_id, child.group_id, groupRemaining);

/**
 * Classify the given listings for a discovery surface (see
 * {@link DiscoveryClassification}).
 *
 * `soldOutParentIds` contains a parent only when it has at least one child edge
 * and *none* of its children are bookable for the combined parent+child demand
 * (invariant I7) — a parent with no edges at all is an ordinary listing and is
 * never forced sold out here.
 */
export const classifyForDiscovery = async (
  listings: readonly ListingWithCount[],
): Promise<DiscoveryClassification> => {
  const ids = listings.map((l) => l.id);
  const [childIds, childrenByParent, parentsByChild] = await Promise.all([
    getChildListingIds(ids),
    getChildrenForParents(ids),
    getParentsForChildren(ids),
  ]);
  const byId = new Map(listings.map((l) => [l.id, l]));
  const everyChild = [...childrenByParent.values()].flat();
  // Displayed children whose add-on label we are deciding. They are in `byId`
  // (keys of parentsByChild are among the displayed `ids`), so their own
  // group-remaining must be fetched for the combined-demand check below — the
  // map is keyed by listing id, so it is unioned into the single child map.
  const displayedChildren = mapNotNullish((id: number) => byId.get(id))([
    ...parentsByChild.keys(),
  ]);
  const everyParent = [...parentsByChild.values()].flat();
  const [groupRemaining, parentGroupRemaining, holidays] = await Promise.all([
    getGroupRemainingByListingId([...everyChild, ...displayedChildren]),
    getGroupRemainingByListingId(everyParent),
    getActiveHolidays(),
  ]);
  // A child is an add-on only when at least one of its parents is itself
  // bookable (active, not sold out, not closed) AND that parent can actually
  // offer THIS child given the *combined* parent+child group demand (invariant
  // I7, Fix 5). Using only `parentBookable` (the parent's own row) would mark a
  // child available as an add-on while the parent's sold-out projection below —
  // which uses childBookableForParent — reads the parent sold out, leaving the
  // note a dead end (e.g. a child whose only parent shares a 1-spot capped group
  // with it: one parent+child order needs two spots). Reuse the same
  // combined-demand check both surfaces use.
  const addOnChildIds = new Set<number>();
  for (const [childId, parents] of parentsByChild) {
    // childId is a key of parentsByChild, which is built from the displayed
    // `ids`, so the listing is always present in `byId` (invariant).
    const child = byId.get(childId)!;
    const offerable = parents.some(
      (p) =>
        parentBookable(p, parentGroupRemaining.get(p.id)) &&
        childBookableForParent(p, child, groupRemaining.get(childId), holidays),
    );
    if (offerable) addOnChildIds.add(childId);
  }
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
