/**
 * Discovery/share-surface suppression for the listing parent/child feature.
 *
 * Every discovery surface (public listing cards, the order gallery, RSS/ICS feeds,
 * the admin multi-booking link builder, per-listing share/QR generators) advertises
 * a standalone `/ticket/<slug>` entry point. Because a booking can never start from
 * a child (invariant I3), a *visible* child must not advertise such a link, and a
 * parent whose required children are **all unavailable** must read as sold out
 * (invariant I6) — else the surface publishes a link the booking gate then rejects.
 * This module is the single source of truth those surfaces share.
 *
 * Availability note: discovery has no submitted date/duration, so child bookability
 * is evaluated at the minimum order (a single day) using the card-level
 * sold-out/closed state — "no child is individually bookable" ⇒ parent sold out.
 * The combined-group-demand refinement (a parent and its auto-selected child sharing
 * a capped group consume two spots) is described in parents.md ("the *combined*
 * parent+child demand check"); the date-/duration-specific evaluation lives in the
 * booking gate, the authority that ultimately rejects an unbookable order. See
 * parents.md, "Public listing cards" and "no bookable child ⇒ sold out".
 */

import { mapNotNullish, mapParallel, unique } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import {
  getGroupRemainingByGroupId,
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#shared/db/attendees.ts";
import {
  getActiveListingsByGroupId,
  getAllGroups,
  getGroupIdsByListingIds,
  getGroupListingIds,
  getGroupPackagePrices,
  getHiddenPackageMemberIds,
  packageMemberMaps,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getChildListingIds,
  getChildrenForParents,
  getParentsForChildren,
} from "#shared/db/listing-parents.ts";
import {
  availableDayCounts,
  type Group,
  type Holiday,
  type ListingWithCount,
  sharedGroupCapacity,
} from "#shared/types.ts";
import {
  buildTicketListing,
  childActive,
  childCalendarOrInStockForSpan,
  childOpen,
  combinedGroupDemandFits,
  fixedParentSpan,
  packageQuantityCap,
  type TicketListing,
} from "#templates/public.tsx";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/**
 * Drop members of a HIDDEN package from a buyer-facing listing set: such a
 * package promises buyers see only its name, never the individual members, so
 * the members must not appear as standalone cards/links/feed items on any
 * public surface. A no-op (and no query) when none of the listings are
 * hidden-package members. The package group itself is unaffected — its CTA is
 * gated separately by {@link packageGroupBookable}.
 */
export const dropHiddenPackageMembers = async <T extends { id: number }>(
  listings: T[],
): Promise<T[]> => {
  const hidden = await getHiddenPackageMemberIds(listings.map((e) => e.id));
  return hidden.size === 0
    ? listings
    : listings.filter((e) => !hidden.has(e.id));
};

/** A group's members as buyers may see them on that group's own surfaces. A
 * package group keeps its full membership — it IS the package — while any other
 * group drops the members of a hidden package, which belong only to that
 * package and must never surface standalone (even via a second group they
 * happen to share). */
export const visibleGroupMembers = <T extends { id: number }>(
  group: { is_package: boolean },
  members: T[],
): Promise<T[]> =>
  group.is_package
    ? Promise.resolve(members)
    : dropHiddenPackageMembers(members);

/** Load a group's active members already filtered to what buyers may see — the
 * "active members → {@link visibleGroupMembers}" step every public group surface
 * (listings page, group QR, direct ticket page) runs before deciding bookability. */
export const getVisibleGroupMembers = async (
  group: Group,
): Promise<ListingWithCount[]> =>
  visibleGroupMembers(group, await getActiveListingsByGroupId(group.id));

/**
 * How a discovery surface should treat each listing:
 * - `childIds` — **every** child of some parent. A booking can never start from a
 *   child (invariant I3) — the slug guard rejects *all* child slugs regardless of
 *   parent.active — so a child's standalone CTA (and feed/gallery/builder/share
 *   affordance) is suppressed in every case, matching what `getChildListingIds`
 *   rejects at the booking entry point.
 * - `addOnChildIds` — the subset of `childIds` with at least one **bookable**
 *   parent (active AND not sold out AND not registration-closed, its own date-less
 *   row availability). Such a child has a live parent page that can offer and fold
 *   it, so its card shows the "available as an add-on" note. A child whose every
 *   parent is inactive/sold out/closed has *no* parent page to offer it (a dead
 *   end), so the note would point at nothing: it renders **unavailable** instead
 *   (parents.md, "Public listing cards", Fix 1).
 * - `soldOutParentIds` — parents with no bookable child (combined parent+child
 *   demand, invariant I7); their card must render sold out (and be omitted from
 *   feeds/gallery), since the booking gate would reject the order.
 */
export type DiscoveryClassification = {
  childIds: ReadonlySet<number>;
  addOnChildIds: ReadonlySet<number>;
  soldOutParentIds: ReadonlySet<number>;
};

/** Whether a built child is individually bookable at render (no submitted date):
 * active, not closed, and — for its capacity component — *potentially* bookable.
 *
 * The sold-out component splits by listing kind (Codex 63). `buildTicketListing`'s
 * `isSoldOut` comes from the date-LESS cumulative aggregate, meaningful only for a
 * STANDARD child. For a DAILY child it is wrong: a 1-capacity daily child booked on
 * one date reads `isSoldOut=true`, globalising that one full date into "sold out for
 * EVERY date" and forcing its parent's card/page sold out on dates the child still
 * has room for. So a daily child is "potentially bookable" whenever active, not
 * closed, and has at least one bookable start date on its own calendar; its true
 * per-date capacity is the submit-side fold's job (rejects — never clamps — a full
 * date). Hidden children stay bookable — `hidden` governs the index, not eligibility
 * (parents.md, Edge cases). */
const childBookable = (
  child: TicketListing,
  holidays: Holiday[],
  parentSpans: (number | null)[],
  parentDates: ReadonlySet<string> | null,
): boolean =>
  childActive(child) &&
  childOpen(child) &&
  // A daily child counts as bookable when it can serve ANY span the parent
  // actually offers (the buyer picks one) — not merely a one-day start. A
  // customisable parent that only prices longer runs offers no 1-day booking,
  // so a one-day fallback would advertise a child it can never fold (Codex).
  parentSpans.some((span) =>
    childCalendarOrInStockForSpan(holidays, span, parentDates)(child),
  );

/** The daily spans a parent could fold a child into at the till — the spans the
 * date-less sold-out projection must test a daily child against. A CUSTOMISABLE
 * daily parent offers each of its priced day counts (a child is bookable if it
 * serves ANY one — the buyer picks the span); a parent pricing no day count
 * offers no bookable span at all, so the empty set leaves every child unbookable
 * (the parent reads sold out). A FIXED daily parent inherits its single
 * `duration_days`; a non-daily parent imposes no daily span (its single
 * {@link fixedParentSpan} stands, and a standard child ignores span anyway). */
const parentOfferedSpans = (parent: ListingWithCount): (number | null)[] =>
  parent.listing_type === "daily" && parent.customisable_days
    ? availableDayCounts(parent)
    : [fixedParentSpan(parent)];

/** Whether a *parent* can currently offer its children as add-ons (Fix 1): its own
 * row must be active AND not sold out AND not registration-closed. An inactive/sold
 * out/closed parent cannot fold a child into a booking, so a child whose only
 * parents are all such has no live parent page to be offered under — a dead end.
 * Judged date-less (the parent's own row availability), matching the rest of
 * discovery. */
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

/** A daily parent's own bookable start dates (its booking page's candidate dates),
 * against which a daily child's calendar must overlap (Fix 5); `null` for a
 * non-daily parent, which has NO date selector — a daily child under it inherits no
 * parent date, so no overlap applies (the child is judged by its own calendar /
 * fixed span). */
const parentDatesOf = (
  parent: ListingWithCount,
  holidays: Holiday[],
): ReadonlySet<string> | null =>
  parent.listing_type === "daily"
    ? new Set(getBookableStartDates(parent, holidays))
    : null;

/** The capacity inputs a child-bookability check needs: the child's OWN per-listing
 * group-remaining (for its sold-out state) plus the PER-GROUP capacity maps and
 * group membership (for the SPECIFIC group it shares with the parent, Codex #3). */
export type ChildCapacityCtx = {
  childOwnRemaining: ReadonlyMap<number, number>;
  remainingByGroupId: ReadonlyMap<number, number>;
  staticCapByGroupId: ReadonlyMap<number, number>;
  membership: ReadonlyMap<number, number[]>;
};

/** Whether a child is bookable *for a given parent* on a discovery surface:
 * individually bookable (active, not sold out/closed at the minimum single-day
 * order), bookable on a date the PARENT can serve (Fix 5), AND combined
 * parent+child demand fits the shared group capacity (invariant I7).
 *
 * The shared-group facts are computed over the group the parent and child SHARE
 * (the per-group maps), not the child's tightest group overall (Codex #3): a child
 * also in a tighter non-shared group must not be wrongly rejected. The shared
 * `staticCap` is date-INDEPENDENT, so a parent+daily-child sharing a group too
 * small to ever hold both is rejected even date-less. */
const childBookableForParent = (
  parent: ListingWithCount,
  child: ListingWithCount,
  caps: ChildCapacityCtx,
  holidays: Holiday[],
): boolean =>
  childBookable(
    buildTicketListing(
      child,
      isRegistrationClosed(child),
      caps.childOwnRemaining.get(child.id),
    ),
    holidays,
    parentOfferedSpans(parent),
    // A daily child must be bookable on a date the PARENT can serve, not merely on
    // its own calendar (Fix 5): else disjoint weekdays leave the parent advertised
    // while `getTicketContext`'s date union renders no valid date. A non-daily
    // parent has no date calendar (null), which the daily-only overlap test ignores
    // for a (necessarily standard) child.
    parentDatesOf(parent, holidays),
  ) &&
  combinedGroupDemandFits(
    sharedGroupCapacity(
      caps.membership.get(parent.id) ?? [],
      caps.membership.get(child.id) ?? [],
      caps.staticCapByGroupId,
      caps.remainingByGroupId,
    ),
  );

/**
 * Classify the given listings for a discovery surface (see
 * {@link DiscoveryClassification}).
 *
 * `soldOutParentIds` contains a parent only when it has at least one child edge and
 * *none* of its children are bookable for the combined parent+child demand
 * (invariant I7) — a parent with no edges is an ordinary listing, never forced sold
 * out here.
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
  // Displayed children whose add-on label we are deciding (keys of parentsByChild
  // are among the displayed `ids`, so they are in `byId`). Their own group-remaining
  // is fetched for the combined-demand check below and unioned into the child map.
  const displayedChildren = mapNotNullish((id: number) => byId.get(id))([
    ...parentsByChild.keys(),
  ]);
  const everyParent = [...parentsByChild.values()].flat();
  const allChildren = [...everyChild, ...displayedChildren];
  const [
    childCaps,
    childOwnRemaining,
    parentGroupRemaining,
    holidays,
    membership,
  ] = await Promise.all([
    getSharedGroupCapacities(allChildren),
    getGroupRemainingByListingId(allChildren),
    getGroupRemainingByListingId(everyParent),
    getActiveHolidays(),
    getGroupIdsByListingIds(
      unique([
        ...byId.keys(),
        ...everyChild.map((c) => c.id),
        ...everyParent.map((p) => p.id),
      ]),
    ),
  ]);
  // Per-GROUP shared facts (the group a parent+child SHARE, Codex #3) plus each
  // child's OWN per-listing remaining (its sold-out state). `membership` covers
  // parents and children alike, so it stands in for `childCaps.membership`.
  const caps: ChildCapacityCtx = {
    childOwnRemaining,
    membership,
    remainingByGroupId: childCaps.remaining,
    staticCapByGroupId: childCaps.staticCap,
  };
  // A child is an add-on only when at least one parent is itself bookable AND can
  // offer THIS child given the *combined* parent+child group demand (invariant I7,
  // Fix 5). Using only `parentBookable` (the parent's own row) would mark a child
  // available while the parent's sold-out projection below (via childBookableForParent)
  // reads the parent sold out, leaving the note a dead end (e.g. a child whose only
  // parent shares a 1-spot capped group with it: one parent+child order needs two
  // spots). Reuse the same combined-demand check both surfaces use.
  const addOnChildIds = new Set<number>();
  for (const [childId, parents] of parentsByChild) {
    // childId comes from the displayed `ids`, so it is always present in `byId`.
    const child = byId.get(childId)!;
    const offerable = parents.some(
      (p) =>
        parentBookable(p, parentGroupRemaining.get(p.id)) &&
        childBookableForParent(p, child, caps, holidays),
    );
    if (offerable) addOnChildIds.add(childId);
  }
  const soldOutParentIds = new Set<number>();
  for (const [parentId, children] of childrenByParent) {
    const parent = byId.get(parentId);
    const anyBookable =
      parent !== undefined &&
      children.some((child) =>
        childBookableForParent(parent, child, caps, holidays),
      );
    if (!anyBookable) soldOutParentIds.add(parentId);
  }
  return { addOnChildIds, childIds, soldOutParentIds };
};

/**
 * Whether a group has an active member that is actually bookable standalone:
 * neither a child (a booking can never start from a child, invariant I3) NOR a
 * parent the classifier projects sold out (its required children all
 * unavailable). The single gate behind both the `/listings` group Book CTA
 * (pages.ts) and the group QR (`/ticket/<group>/qr`, ticket-routes.ts), so the
 * two surfaces can't drift: a group `/ticket/<group>` would render with no
 * bookable quantity never advertises a Book link or mints a QR pointing at it.
 * Callers pass the group's already-loaded active members.
 */
export const groupHasBookableMember = async (
  members: readonly ListingWithCount[],
): Promise<boolean> => {
  if (members.length === 0) return false;
  const { childIds, soldOutParentIds } = await classifyForDiscovery(members);
  return members.some(
    (m) => !childIds.has(m.id) && !soldOutParentIds.has(m.id),
  );
};

/**
 * Whether a PACKAGE group can sell at least one whole bundle. A package is all
 * or nothing — every member is booked together — so the standalone-member gate
 * ({@link groupHasBookableMember}) is wrong here: it would advertise a Book CTA
 * for a package whose one sold-out/closed member caps `packageQuantityCap` at 0,
 * landing the buyer on a page that can only fail. Gate on the real package cap
 * (each member's capacity AND the shared pool ÷ combined member demand) ≥ 1, and
 * require EVERY member to be active — a package is all-or-nothing, so one
 * inactive member makes the whole bundle unavailable rather than silently
 * selling the active subset. Callers pass the group's already-loaded active
 * members.
 */
export const packageGroupBookable = async (
  members: readonly ListingWithCount[],
  groupId: number,
): Promise<boolean> => {
  if (members.length === 0) return false;
  const [allMemberIds, ticketListings, rows, remaining] = await Promise.all([
    getGroupListingIds(groupId),
    buildTicketListingsWithGroupCapacity([...members]),
    getGroupPackagePrices(groupId),
    getGroupRemainingByGroupId([groupId]),
  ]);
  // An inactive member is absent from `members` (active only) but still a group
  // row, so fewer active members than total means the bundle is incomplete.
  if (members.length < allMemberIds.length) return false;
  return (
    packageQuantityCap(
      ticketListings,
      packageMemberMaps(rows).quantities,
      remaining.get(groupId) ?? null,
    ) >= 1
  );
};

/** Whether a group's `/listings` CTA / QR should be offered: a regular group
 * needs one standalone-bookable member ({@link groupHasBookableMember}); a
 * PACKAGE needs the whole bundle to fit ({@link packageGroupBookable}). The
 * single decision both the listings page and the group QR share. */
export const groupBookable = (
  group: Group,
  members: readonly ListingWithCount[],
): Promise<boolean> =>
  group.is_package
    ? packageGroupBookable(members, group.id)
    : groupHasBookableMember(members);

/** Load non-hidden groups whose Book CTA leads to a bookable page, so a
 * child-only or sold-out group never advertises a dead link. A regular group
 * needs one standalone-bookable member ({@link groupHasBookableMember}); a
 * PACKAGE needs the whole bundle to fit ({@link packageGroupBookable}). Shared
 * by every public surface that lists groups (the `/listings` page and the
 * `/order` gallery). */
export const loadPublicGroups = async (): Promise<Group[]> => {
  const groups = (await getAllGroups()).filter((g) => !g.hidden);
  const bookable = await mapParallel(async (g: Group) =>
    groupBookable(g, await getVisibleGroupMembers(g)),
  )(groups);
  return groups.filter((_, i) => bookable[i]);
};

/** Force a {@link TicketListing} into the sold-out state (no Book CTA, no
 * purchasable quantity) — projecting a parent with no bookable child onto the
 * card/gallery state the booking gate will enforce. */
const asSoldOut = (info: TicketListing): TicketListing => ({
  ...info,
  isSoldOut: true,
  maxPurchasable: 0,
});

/** Apply the parent-sold-out classification to a list of {@link TicketListing}
 * (children are still returned — public cards keep the child's card and only
 * suppress its standalone CTA). A parent with no bookable child is projected to the
 * sold-out state. */
export const applyParentSoldOut = (
  listings: readonly TicketListing[],
  { soldOutParentIds }: DiscoveryClassification,
): TicketListing[] =>
  listings.map((info) =>
    soldOutParentIds.has(info.listing.id) ? asSoldOut(info) : info,
  );

/**
 * Project the booking page's own listings to sold-out for any parent whose children
 * are ALL unavailable (invariant I6), reusing the page's already-built
 * `childrenByParentId` rather than re-querying. Mirrors discovery/feed behaviour on
 * `/ticket/<parent>` so a parent with no bookable child renders sold out (no
 * quantity selector / Book control) instead of a form that could only fail with the
 * child-sold-out error at submit (Codex 914). A listing with no child edge is left
 * untouched; the authoritative date-specific rejection still happens in the submit
 * fold.
 *
 * `caps` carries the PER-GROUP shared facts (the group a parent and child SHARE,
 * Codex #3) so the test uses the *combined* parent+child demand (invariant I7): a
 * parent and its child in the same capped group consume two spots, so a parent with
 * a single remaining group spot reads sold out here too — matching what submit-time
 * `checkBatchAvailability` would reject. The shared `staticCap` is date-INDEPENDENT,
 * so a parent whose only child shares a group too small to ever hold both reads sold
 * out even when that child is daily (no per-date remaining without a date).
 *
 * `holidays` lets a daily child's render-time bookability be judged by its own
 * calendar rather than the date-less `isSoldOut` aggregate (Codex 63 — see
 * {@link childBookable}), so a daily child full on one date doesn't force its
 * parent's page sold out for every date.
 */
export const applyBookingPageParentSoldOut = (
  listings: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
  caps: ChildCapacityCtx,
  holidays: Holiday[],
): TicketListing[] =>
  listings.map((info) => {
    const children = childrenByParentId.get(info.listing.id);
    const anyBookable = children?.some((child) =>
      childBookableForParent(info.listing, child.listing, caps, holidays),
    );
    if (children && children.length > 0 && !anyBookable) {
      return asSoldOut(info);
    }
    return info;
  });
