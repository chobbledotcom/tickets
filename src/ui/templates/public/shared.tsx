import { t } from "#i18n";
import { isContactFormActive } from "#shared/contact-form.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { NavLevel, NavModel, NavNode } from "#shared/site-pages/types.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  dayPriceFor,
  type Holiday,
  type ListingWithCount,
  normalizeDurationDays,
  PARENT_CHILD_GROUP_UNITS,
  type SharedGroupCapacity,
} from "#shared/types.ts";
import { desktopNavShell, mobileNavBar } from "#templates/components/nav.tsx";
import { escapeHtml } from "#templates/layout.tsx";

/** Everything {@link PublicNav} renders: the settings-driven page flags plus
 * the site-pages tree (built per request by `publicNavProps`, site-nav.ts). */
export type PublicNavProps = {
  hasTerms: boolean;
  hasContact: boolean;
  hasOrder: boolean;
  pages: NavModel;
};

/** A nav node as a link — or plain text when the target isn't publicly
 * reachable (never render a dead link). The active-chain node is marked. */
export const NodeLink = ({ node }: { node: NavNode }): JSX.Element =>
  node.live ? (
    <a class={node.active ? "active" : undefined} href={node.href}>
      {node.label}
    </a>
  ) : (
    <span>{node.label}</span>
  );

/** Desktop: the submenu levels nested recursively — level `depth` renders
 * beneath the active node of the level above (the next page on the active
 * chain), indenting one step per level like the admin sub-nav. The model
 * never carries an empty level, so every rendered `<ul>` has children. */
const DesktopLevels = ({
  levels,
  depth,
}: {
  levels: readonly NavLevel[];
  depth: number;
}): JSX.Element | null =>
  depth >= levels.length ? null : (
    <ul class="admin-subnav">
      {levels[depth]!.nodes.map((node) => (
        <li>
          <NodeLink node={node} />
          {node.active && <DesktopLevels depth={depth + 1} levels={levels} />}
        </li>
      ))}
    </ul>
  );

/** The fixed root links, with the root page nodes spliced between Listings and
 * the Order/Terms/Contact group ("between listings and contact"). Each page
 * `<li>` may carry extra children (the desktop nesting), supplied per node. */
const rootItems = (
  { hasTerms, hasContact, hasOrder, pages }: PublicNavProps,
  nested: (node: NavNode) => JSX.Element | null,
): JSX.Element[] => [
  <li>
    <a href="/">{t("nav.public.home")}</a>
  </li>,
  <li>
    <a href="/listings">{t("terms.listings")}</a>
  </li>,
  ...pages.rootPageNodes.map((node) => (
    <li>
      <NodeLink node={node} />
      {nested(node)}
    </li>
  )),
  ...(hasOrder
    ? [
        <li>
          <a href="/order">{t("nav.public.order")}</a>
        </li>,
      ]
    : []),
  ...(hasTerms
    ? [
        <li>
          <a href="/terms">
            <Raw html={t("nav.public.terms")} />
          </a>
        </li>,
      ]
    : []),
  ...(hasContact
    ? [
        <li>
          <a href="/contact">{t("nav.public.contact")}</a>
        </li>,
      ]
    : []),
];

/** Mobile: the root bar, then one bar per active-chain level (root-first),
 * each carrying its page's name as the bar's accessible label. */
const MobilePublicNav = (props: PublicNavProps): JSX.Element => (
  <>
    {mobileNavBar(
      t("nav.public.main"),
      rootItems(props, () => null),
    )}
    {props.pages.submenuLevels.map((level) =>
      mobileNavBar(
        level.label,
        level.nodes.map((node) => (
          <li>
            <NodeLink node={node} />
          </li>
        )),
      ),
    )}
  </>
);

/**
 * Public site navigation: the fixed links (Home, Listings, Order/Terms/Contact
 * when enabled) with the operator's root pages spliced in between, plus the
 * recursive contextual submenus along the active chain. Mirrors the admin
 * pattern — one nested sidebar on desktop, separate stacked bars on mobile —
 * by reusing its proven CSS (`admin-nav--desktop` / `admin-subnav` /
 * `admin-nav--mobile`; `.admin-nav-group` pins the desktop sidebar). It must
 * NOT carry the admin nav's `#main-nav` id: the stylesheet reads that id as
 * "this is an admin page" (full-bleed main, admin textarea sizing), while a
 * public page keeps the shared 800px reading width.
 */
export const PublicNav = (props: PublicNavProps): JSX.Element => (
  <div class="admin-nav-group">
    {desktopNavShell(
      t("nav.public.main"),
      rootItems(props, (node) =>
        node.active ? (
          <DesktopLevels depth={0} levels={props.pages.submenuLevels} />
        ) : null,
      ),
    )}
    <MobilePublicNav {...props} />
  </div>
);

/** Compute which public pages have content.
 * The Contact link also shows when the contact form is active, even if the
 * contact page has no descriptive text of its own. The Order link shows
 * whenever the owner has enabled the order page. */
export const navFlags = () => ({
  hasContact: !!settings.contactPageText || isContactFormActive(),
  hasOrder: settings.orderEnabled,
  hasTerms: !!settings.terms,
});

/** The footer every public page ends with: the one admin-login link. */
export const LoginFooter = (): JSX.Element => (
  <footer class="homepage-footer">
    <p>
      <a href="/admin/login">{t("common.login")}</a>
    </p>
  </footer>
);

/** Operator-authored markdown rendered into the shared `.prose` block —
 * nothing at all when the markdown is empty. */
export const MarkdownProse = ({
  markdown,
}: {
  markdown: string;
}): JSX.Element | null =>
  markdown ? (
    <div class="prose">
      <Raw html={renderMarkdown(markdown)} />
    </div>
  ) : null;

export const RSS_DISCOVERY_TAG =
  '<link rel="alternate" type="application/rss+xml" title="Listings" href="/feeds/listings.rss" />';

export const ICS_DISCOVERY_TAG =
  '<link rel="alternate" type="text/calendar" title="Listings" href="/feeds/listings.ics" />';

export const FEED_DISCOVERY_TAGS = `${RSS_DISCOVERY_TAG}\n${ICS_DISCOVERY_TAG}`;

/** Render listing image HTML if image_url is set */
export const renderListingImage = (
  listing: { image_url: string },
  className = "listing-image",
): string =>
  listing.image_url
    ? `<img src="${escapeHtml(
        getImageProxyUrl(listing.image_url),
      )}" alt="" class="${className}" />`
    : "";

/** Listing info for ticket display */
export type TicketListing = {
  listing: import("#shared/types.ts").ListingWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/**
 * Curried, composable child-availability ATOMS plus a single combinator
 * ({@link selectableChild}) — the one source of truth every parent/child surface
 * (discovery, the submit fold, and the booking-page render) re-expresses its own
 * predicate through, so the many slightly-differently-phrased
 * "is this child bookable?" ideas share one implementation.
 *
 * Each atom is a pure `(child) => boolean` (some curried over the context the
 * caller carries — span, date, holidays, group-remaining). The combinator ANDs
 * exactly the atoms a caller passes, so a site keeps its EXACT current behaviour
 * by composing the atoms it used before — no more, no less.
 */

/** The composite key for a parent→child date constraint (Fix 4). The same daily
 * child can be required by two parents whose calendars differ, so its serveable
 * dates (`data-child-dates`) must be keyed by the (parent, child) PAIR — keying by
 * child id alone let the later parent overwrite the earlier parent's constraint,
 * so a child rendered under one parent could carry the other parent's dates. The
 * single source of truth both the producer (`buildChildDatesById`,
 * ticket-payment.ts) and the render consumer (`childCompatAttrs`,
 * reservations.tsx) compute the lookup key through. */
export const childDateKey = (parentId: number, childId: number): string =>
  `${parentId}:${childId}`;

/** A daily child's serveable start dates per selectable parent day-count (Fix 4):
 * span (day-count) → the holiday-aware starts from which the child can serve the
 * WHOLE span. A FIXED-duration parent has a single entry keyed by its one span; a
 * CUSTOMISABLE parent has one entry per selectable day-count, so the render and
 * the client compatibility script can pick the dates matching the buyer's chosen
 * `day_count` (rather than the span-agnostic one-day starts that let a 2-day child
 * be offered a Monday it can't cover). Encoded into `data-child-dates` as
 * `span:d,d|span:d,d` ({@link encodeChildSpanDates}). */
export type ChildSpanDates = ReadonlyMap<number, string[]>;

/** Encode a child's per-span serveable dates for the `data-child-dates`
 * attribute: each `span:date,date,…` segment joined by `|` (Fix 4). The single
 * source of truth both the render producer ({@link childCompatAttrs}) and the
 * client consumer (`child-compat.ts` `parseChildSpanDates`) format/parse, so the
 * span-keyed wire shape lives in one place. Empty spans are kept (a span the
 * child can't serve at all encodes `span:` with no dates), so the client can tell
 * "no date serves this span" from "this span isn't constrained". */
export const encodeChildSpanDates = (bySpan: ChildSpanDates): string =>
  [...bySpan].map(([span, dates]) => `${span}:${dates.join(",")}`).join("|");

/** The child's listing row is active (the fold rejects an inactive child). */
export const childActive = (child: TicketListing): boolean =>
  child.listing.active;

/** The child is not registration-closed. */
export const childOpen = (child: TicketListing): boolean => !child.isClosed;

/** Date-less sold-out check: a STANDARD child's capacity is cumulative and
 * date-independent, so `isSoldOut` is authoritative; a DAILY child never reads
 * sold out date-lessly ({@link buildTicketListing} makes no date-less capacity
 * claim for daily listings — its per-date capacity is judged downstream once a
 * date is known), so this is safe for every kind. */
export const childInStock = (child: TicketListing): boolean => !child.isSoldOut;

/** Whether a DAILY child has at least one bookable start that COVERS `span` on
 * its own calendar (the single source of truth for "a valid start for the span
 * exists", shared by discovery's sold-out projection and the fold's date union):
 * each candidate start is validated with {@link isBookingRangeValid} over `span`,
 * the same rule the date union uses. `parentDates`, when non-null, ALSO restricts
 * the candidate starts to the parent's own bookable dates (Fix 5) — so a child
 * whose only bookable weekdays are disjoint from the parent's counts as
 * unbookable (the parent renders sold out rather than advertising a date the
 * booking context can never serve). A `null` `parentDates` means the parent has
 * no date calendar to intersect (a non-daily parent of a daily child), so only
 * the child's own calendar is checked. */
const childHasStartForSpan = (
  child: TicketListing,
  span: number,
  holidays: Holiday[],
  parentDates: ReadonlySet<string> | null,
): boolean =>
  getBookableStartDates(child.listing, holidays).some(
    (date) =>
      (parentDates === null || parentDates.has(date)) &&
      isBookingRangeValid(child.listing, date, span, holidays),
  );

/** Span-AWARE variant of {@link childCalendarOrInStock} for a parent whose
 * inherited span is FIXED at discovery (a fixed daily parent): a daily child
 * counts only when a valid start covering `span` exists ({@link
 * childHasStartForSpan}) — not merely any one-day start — so a parent whose only
 * child can never fit its fixed multi-day window reads sold out (parents.md Fix
 * 1). A `null` span (a customisable parent, whose span the buyer picks later)
 * checks a single-day start. `parentDates`, when non-null (a DAILY parent's own
 * candidate dates), additionally requires the child's bookable start to OVERLAP
 * the parent's dates (Fix 5): disjoint weekdays leave the parent sold out. A
 * `null` `parentDates` (a non-daily parent, which has no date selector) imposes
 * no overlap. A non-daily child has no date constraint, so it is judged by its
 * date-less in-stock state ({@link childInStock}). */
export const childCalendarOrInStockForSpan =
  (
    holidays: Holiday[],
    span: number | null,
    parentDates: ReadonlySet<string> | null,
  ) =>
  (child: TicketListing): boolean =>
    child.listing.listing_type === "daily"
      ? childHasStartForSpan(child, span ?? 1, holidays, parentDates)
      : childInStock(child);

/** The child can be PRICED for the inherited span: a customisable child must
 * have a day price for `duration`; any other child prices independently of it. */
export const childPricedForSpan =
  (duration: number) =>
  (child: TicketListing): boolean =>
    !child.listing.customisable_days ||
    dayPriceFor(child.listing, duration) !== null;

/** The child's booked span matches the parent's inherited `duration`: a
 * customisable child inherits it directly; a fixed DAILY child is booked for its
 * own `duration_days`, so it folds only when that equals `duration`; a standard
 * child is duration 1 and unaffected. */
export const childDurationMatches =
  (duration: number) =>
  (child: TicketListing): boolean =>
    child.listing.customisable_days ||
    child.listing.listing_type !== "daily" ||
    normalizeDurationDays(child.listing.duration_days) === duration;

/** The order's resolved `date` is a valid start on a DAILY child's own calendar
 * for the inherited `duration` (a customisable child validates the whole span; a
 * fixed daily child validates the start). A standard (dateless) child has no
 * date constraint of its own. */
export const childDateOk =
  (date: string | null, holidays: Holiday[], duration: number) =>
  (child: TicketListing): boolean => {
    if (child.listing.listing_type !== "daily") return true;
    if (!date) return false;
    return child.listing.customisable_days
      ? isBookingRangeValid(child.listing, date, duration, holidays)
      : getBookableStartDates(child.listing, holidays).includes(date);
  };

/** The *combined* one-parent-plus-one-child minimum order fits the capacity the
 * two share (invariant I7): co-grouped in a capped group they consume
 * {@link PARENT_CHILD_GROUP_UNITS} spots, so the share must clear that minimum
 * on BOTH facts of {@link SharedGroupCapacity} — its structural ceiling
 * (`staticCap`, so a group too small to EVER hold parent+child is rejected even
 * date-less, when a daily child's per-date `remaining` is unknown) and its
 * currently-free `remaining` (when known). Either fact `undefined` means "no
 * constraint from this fact"; not co-grouped ⇒ both `undefined` ⇒ always fits. */
export const combinedGroupDemandFits = (cap: SharedGroupCapacity): boolean =>
  (cap.staticCap === undefined || cap.staticCap >= PARENT_CHILD_GROUP_UNITS) &&
  (cap.remaining === undefined || cap.remaining >= PARENT_CHILD_GROUP_UNITS);

/** How many whole orders fit in one capped group pool when each order consumes
 * `demand` (≥ 1) spots: `floor(remaining / demand)`. The single source of the
 * shared-group pool division reused by every render-time capacity cap — a
 * package bundle (demand = Σ member quantities in the group) and a parent+child
 * cohort (demand = {@link PARENT_CHILD_GROUP_UNITS}). */
export const groupPoolUnits = (remaining: number, demand: number): number =>
  Math.floor(remaining / demand);

/** Combine a list of child-availability atoms into one predicate that ANDs them
 * all. Callers compose exactly the atoms their site needs (via {@link
 * compact} to drop the optional ones they don't), keeping behaviour identical. */
export const selectableChild =
  (atoms: ((child: TicketListing) => boolean)[]) =>
  (child: TicketListing): boolean =>
    atoms.every((atom) => atom(child));

/** Whether a required child clears the date- AND span-INDEPENDENT disqualifiers:
 * active, not registration-closed, and not sold out (a daily child never reads
 * sold out date-lessly; its per-date capacity is judged downstream). The single
 * source of truth both the date union (ticket-payment.ts) and the day-count
 * union (reservations.tsx) use to drop children the fold would categorically
 * reject (parents.md Fixes 2–4). Span- and date-dependent checks layer on top in
 * the caller that knows the inherited span/date. */
export const childSelectableIgnoringSpan: (child: TicketListing) => boolean =
  selectableChild([childActive, childOpen, childInStock]);

/** The ids of every currently-bookable child on a page (span-independent
 * disqualifiers only), for surfaces that price or cap over the tree's child
 * nodes — bookability is a render fact the tree doesn't carry. */
export const bookableChildIds = (
  childrenByParentId: ReadonlyMap<number, TicketListing[]> | undefined,
): ReadonlySet<number> =>
  new Set(
    [...(childrenByParentId?.values() ?? [])]
      .flat()
      .filter(childSelectableIgnoringSpan)
      .map((child) => child.listing.id),
  );

/** Single source of truth for the duration a parent's children inherit
 * (invariant I4), parameterised by what each surface uses when the parent's span
 * is NOT fixed at the call: a CUSTOMISABLE parent yields `customisableValue` (the
 * resolved/submitted day count, or `null` at render when no span is chosen yet);
 * a fixed DAILY parent yields its `duration_days`; a STANDARD parent yields
 * `standardValue`. Callers specialise it:
 *  - submit fold (`parentResolvedDuration`): `(dayCount, 1)`;
 *  - render duration (`parentRenderDuration`): `(null, 1)`;
 *  - render fixed span (`fixedParentSpan`): `(null, duration_days)`. */
export const resolveInheritedDuration = <T extends number | null>(
  parent: Pick<
    ListingWithCount,
    "customisable_days" | "duration_days" | "listing_type"
  >,
  customisableValue: T,
  standardValue: T,
): T => {
  if (parent.customisable_days) return customisableValue;
  if (parent.listing_type === "daily") {
    return normalizeDurationDays(parent.duration_days) as T;
  }
  return standardValue;
};

/** A parent's FIXED inherited span when there is a single span without a chosen
 * day-count — its `duration_days` for a fixed daily parent, 1 for a standard
 * parent, and `null` for a customisable parent (the buyer picks the span). The
 * single source of truth shared by the booking-page date union (ticket-payment.ts)
 * and discovery's span-aware sold-out projection (discovery.ts, Fix 1).
 * Specialises {@link resolveInheritedDuration} with `(null, duration_days)`. */
export const fixedParentSpan = (
  parent: Pick<
    ListingWithCount,
    "customisable_days" | "duration_days" | "listing_type"
  >,
): number | null =>
  resolveInheritedDuration<number | null>(
    parent,
    null,
    normalizeDurationDays(parent.duration_days),
  );

/**
 * One "union over selectable children" combinator (parents.md "union before
 * selection"): constrain a parent's offered `options` to those at least one of
 * its SELECTABLE children supports — `options ∩ (UNION of each child's
 * contribution)`. The two booking-page surfaces specialise it: the date selector
 * (`constrainDatesByChildUnion`, ticket-payment.ts) over bookable start dates,
 * and the day-count selector (`constrainDayCountsByChildUnion`, here) over
 * supported spans. `selectable` drops children the fold would categorically
 * reject (so they contribute nothing); `contribution` returns the subset of
 * `options` a kept child supports — return all of `options` for a child that
 * imposes no constraint ("any"). With no selectable child the union is empty, so
 * nothing is offered (the parent is sold out and the gate rejects anyway). */
export const constrainOptionsByChildUnion = <T,>(
  options: T[],
  children: TicketListing[],
  selectable: (child: TicketListing) => boolean,
  contribution: (child: TicketListing) => T[],
): T[] => {
  const union = new Set<T>();
  for (const child of children.filter(selectable)) {
    for (const value of contribution(child)) union.add(value);
  }
  return options.filter((value) => union.has(value));
};

/** `groupRemaining`, when defined, clamps the displayed sold-out state and
 * `maxPurchasable` to the group's combined cap. */
export const buildTicketListing = (
  listing: import("#shared/types.ts").ListingWithCount,
  closed: boolean,
  groupRemaining: number | undefined,
): TicketListing => {
  // A DAILY listing's `attendee_count` is cumulative across every date, so it
  // is not a date-less capacity fact: full on one date must not read "sold
  // out" for all the empty ones. Date-less surfaces therefore make NO capacity
  // claim for a daily listing (mirroring getGroupRemainingByListingId, which
  // drops daily group pools without a date) — the buyer picks a date and the
  // per-date clamp plus the atomic write judge that date authoritatively.
  const listingRemaining =
    listing.listing_type === "daily"
      ? Number.POSITIVE_INFINITY
      : listing.max_attendees - listing.attendee_count;
  const spotsRemaining =
    groupRemaining === undefined
      ? listingRemaining
      : Math.min(listingRemaining, groupRemaining);
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(listing.max_quantity, spotsRemaining);
  return { isClosed: closed, isSoldOut, listing, maxPurchasable };
};
