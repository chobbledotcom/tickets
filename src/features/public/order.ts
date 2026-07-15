/**
 * Public order page.
 *
 * `GET /order` renders a gallery of every bookable listing AND package as a
 * grid of selectable cards with a floating cart. Selection, the live count,
 * and showing/hiding the cart are pure CSS (`:checked` + a counter + `:has()`),
 * so the page works with no JavaScript.
 *
 * A small enhancement script keeps availability LIVE as the visitor builds
 * their order: on every change it asks `GET /order/availability` (same wire
 * format as the cart form) how each card now stands, and greys out what no
 * longer fits — naming the earlier choice to remove when the visitor's own
 * selection holds the contested capacity ("Remove <name> to add" rather than
 * "Sold out"). Items needing a date (daily listings, packages with daily
 * members) prompt for the date field instead of guessing. The evaluation is
 * the pure `#shared/order` core; this module only loads its inputs, so the
 * same process can drive other surfaces (e.g. an admin day-booking screen).
 *
 * The cart is a GET form that submits back to `/order`; when the request
 * carries a selection the handler 303-redirects to the canonical booking page
 * `/ticket/<slugs>?q_<id>=1…&date=…` — slugs may name packages, so one booking
 * carries every chosen bundle alongside ordinary listings. Nothing selected is
 * ever dropped: the booking page and its submit stay the availability
 * authority, so the redirect can't silently shrink an order.
 *
 * Known advisory limits (the booking form still enforces the real thing): an
 * option's demand covers its direct listings, not the required children the
 * form will auto-fold under them, so two selections contending for a shared
 * child pool read as available here and are refused at the form instead.
 */

import { compact, requiredMapValue, uniqueBy } from "#fp";
import { t } from "#i18n";
import {
  htmlResponse,
  jsonResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { getGroupRemainingForSpan } from "#shared/db/attendees/capacity/groups.ts";
import { getListingRemainingForRange } from "#shared/db/attendees/capacity/remaining.ts";
import { getSelectedAttributesForListings } from "#shared/db/attributes.ts";
import {
  getGroupPackagePricesByGroupIds,
  listingGroups,
  packageMemberMaps,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { settings } from "#shared/db/settings.ts";
import { evaluateOrder } from "#shared/order/evaluate.ts";
import {
  listingOption,
  type OrderOption,
  type OrderOptionState,
  type OrderPools,
  packageOption,
} from "#shared/order/options.ts";
import {
  orderedSelectionKeys,
  selectedStartDate,
} from "#shared/order-select.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { orderGalleryPage } from "#templates/public/order-gallery.tsx";
/* jscpd:ignore-start */
import {
  applyParentSoldOut,
  classifyForDiscovery,
  dropHiddenPackageMembers,
} from "./discovery.ts";
import { loadBookablePackages } from "./group-liveness.ts";
import { publicNavProps } from "./site-nav.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/* jscpd:ignore-end */

/** Active, visible listings are the items offered on the order page. */
const isOrderListing = (e: ListingWithCount): boolean => e.active && !e.hidden;

/** Load the bookable listings for the order page, in the standard sorted order. */
const loadOrderListings = async (): Promise<ListingWithCount[]> =>
  (await loadSortedListings(isOrderListing)).listings;

/**
 * Guard: the order page is available only when the public site is on and the
 * owner has enabled it. Returns a Response to short-circuit, or null to proceed
 * — redirecting to admin login when the whole public site is off (as the other
 * public pages do) and 404ing when only the order page is disabled.
 */
const orderUnavailable = (): Response | null => {
  if (!settings.showPublicSite) return redirectResponse("/admin/login");
  if (!settings.orderEnabled) return notFoundResponse();
  return null;
};

/** One selectable package with everything its card and its option need. */
export type OrderPackage = {
  group: Group;
  members: ListingWithCount[];
  /** How many units of each member one package books. */
  quantities: ReadonlyMap<number, number>;
};

/** Everything the order surfaces share: the listing cards, the packages, and
 * the option list (in gallery order) the evaluator judges. */
type OrderCatalog = {
  ticketListings: TicketListing[];
  packages: OrderPackage[];
  options: OrderOption[];
};

/** Load the order page's catalog: the selectable listing cards (children and
 * hidden-package members never appear standalone), the bookable packages with
 * their members, and the evaluator options for both. */
const loadOrderCatalog = async (): Promise<OrderCatalog> => {
  const [rawListings, packageGroups] = await Promise.all([
    loadOrderListings(),
    loadBookablePackages(),
  ]);
  // A hidden package's members never appear standalone — only the package name
  // is public — so drop them before classifying and building cards.
  const listings = await dropHiddenPackageMembers(rawListings);
  const [classification, priceRowsByGroupId] = await Promise.all([
    classifyForDiscovery(listings),
    getGroupPackagePricesByGroupIds(packageGroups.map(({ group }) => group.id)),
  ]);
  // Drop non-standalone children (not selectable), then build cards and project
  // child-derived sold-out onto the surviving parents. A `bookable_alone` child
  // keeps its card and joins the cart like any listing; when its parent lands
  // on the same booking page (directly or inside a package) the form re-folds
  // it, so its units are chosen through the parent's child selector there.
  const offered = listings.filter(
    (e) => !classification.nonStandaloneChildIds.has(e.id),
  );
  const ticketListings = applyParentSoldOut(
    await buildTicketListingsWithGroupCapacity(offered),
    classification,
  );
  // A bookable bundle always has membership price rows.
  const packages = packageGroups.map(
    ({ group, members }): OrderPackage => ({
      group,
      members,
      quantities: packageMemberMaps(
        requiredMapValue(
          priceRowsByGroupId,
          group.id,
          `Package prices missing for group ${group.id}`,
        ),
      ).quantities,
    }),
  );
  const options = [
    // Bookable packages lead the gallery; the shared package gate already
    // proved each whole bundle fits, so they are bookable alone.
    ...packages.map((pkg) =>
      packageOption(pkg.group, pkg.members, pkg.quantities, true),
    ),
    ...ticketListings.map((info) =>
      listingOption(info.listing, !info.isSoldOut && !info.isClosed),
    ),
  ];
  return { options, packages, ticketListings };
};

/** The span a listing's booking occupies from a chosen start date: a fixed
 * daily listing books its whole duration (capacity must hold on EVERY day); a
 * customisable one is judged at its shortest bookable span (the gallery can't
 * know the buyer's choice yet); everything else is dateless. */
const bookingSpanDays = (listing: ListingWithCount): number =>
  listing.listing_type === "daily" && !listing.customisable_days
    ? Math.max(1, listing.duration_days)
    : 1;

/** Remaining bookable units keyed by listing or group id. */
type RemainingById = Map<number, number>;

/** Bucket values by their booking span and run one pool query per distinct
 * span, merging the maps — the shared shell of the listing and group pool
 * loaders below. */
const poolBySpan = async <T>(
  values: T[],
  spanOf: (value: T) => number,
  query: (bucket: T[], span: number) => Promise<RemainingById>,
): Promise<RemainingById> => {
  const bySpan = Map.groupBy(values, spanOf);
  const maps = await Promise.all(
    [...bySpan].map(([span, bucket]) => query(bucket, span)),
  );
  return new Map(maps.flatMap((map) => [...map]));
};

/** Each involved listing's remaining units for the chosen date, judged over
 * its own booking span — one range query per distinct span. */
const remainingBySpan = (
  involved: ListingWithCount[],
  date: string | null,
): Promise<RemainingById> =>
  poolBySpan(
    involved,
    (listing) => (date === null ? 1 : bookingSpanDays(listing)),
    (bucket, span) => getListingRemainingForRange(bucket, date, span),
  );

/** Each capped group's remaining, judged over the WIDEST booking span among
 * its involved listings — the cap must hold on every day any of them would
 * occupy, and the evaluator sums the selections sharing the pool against this
 * one figure. */
const groupRemainingBySpan = (
  involved: ListingWithCount[],
  groupIdsByListingId: Map<number, number[]>,
  date: string | null,
): Promise<RemainingById> => {
  const spanByGroupId = new Map<number, number>();
  for (const listing of involved) {
    const span = date === null ? 1 : bookingSpanDays(listing);
    for (const groupId of listingGroups.idsFor(
      groupIdsByListingId,
      listing.id,
    )) {
      spanByGroupId.set(
        groupId,
        Math.max(span, spanByGroupId.get(groupId) ?? 1),
      );
    }
  }
  return poolBySpan(
    [...spanByGroupId],
    ([, span]) => span,
    (bucket, span) =>
      getGroupRemainingForSpan(
        bucket.map(([groupId]) => groupId),
        date,
        span,
      ),
  );
};

/** The capacity pools the evaluator draws from, resolved for the chosen date
 * (or datelessly when none is chosen): each involved listing's remaining
 * (already clamped by its groups, across its whole booking span) and each
 * capped group's remaining, so demand two selections place on a shared pool
 * adds up. A daily listing whose calendar cannot serve the chosen date reads
 * as zero remaining. */
const loadOrderPools = async (
  catalog: OrderCatalog,
  date: string | null,
): Promise<OrderPools> => {
  const involved = uniqueBy((listing: ListingWithCount) => listing.id)([
    ...catalog.ticketListings.map((info) => info.listing),
    ...catalog.packages.flatMap((pkg) => pkg.members),
  ]);
  const groupIdsByListingId = await listingGroups.getIdsByKeys(
    involved.map((listing) => listing.id),
  );
  const [remainingByListingId, remainingByGroupId, holidays] =
    await Promise.all([
      remainingBySpan(involved, date),
      groupRemainingBySpan(involved, groupIdsByListingId, date),
      date === null ? Promise.resolve([]) : getActiveHolidays(),
    ]);
  if (date !== null) {
    for (const listing of involved) {
      if (
        listing.listing_type === "daily" &&
        !getBookableStartDates(listing, holidays).includes(date)
      ) {
        remainingByListingId.set(listing.id, 0);
      }
    }
  }
  return { groupIdsByListingId, remainingByGroupId, remainingByListingId };
};

type OrderEvaluation = {
  states: Map<string, OrderOptionState>;
  selectedKeys: string[];
  date: string | null;
  dateNeeded: boolean;
};

/** Evaluate the request's selection against the catalog. */
const evaluateRequest = async (
  catalog: OrderCatalog,
  params: URLSearchParams,
): Promise<OrderEvaluation> => {
  const date = selectedStartDate(params) || null;
  const selectedKeys = orderedSelectionKeys(params);
  const pools = await loadOrderPools(catalog, date);
  const states = evaluateOrder(
    catalog.options,
    pools,
    selectedKeys,
    date !== null,
  );
  const optionByKey = new Map(
    catalog.options.map((option) => [option.key, option]),
  );
  // The date prompt fires when a chosen item can't be judged without one.
  const dateNeeded =
    date === null &&
    selectedKeys.some((key) => optionByKey.get(key)?.needsDate === true);
  return { date, dateNeeded, selectedKeys, states };
};

/** The user-facing label for a card's live state. Exhaustive over every state
 * kind — a new kind must decide its label here (a missing case is a compile
 * error), never silently show none. A selected or plainly-available card
 * needs no label. */
const stateLabel = (state: OrderOptionState): string => {
  switch (state.kind) {
    case "blocked":
      return t("public.order.remove_to_add", { name: state.byName });
    case "needs_date":
      return t("public.order.pick_date_to_see");
    case "unavailable":
      return t("public.sold_out");
    case "selected":
    case "available":
      return "";
  }
};

/**
 * Build the booking-page URL for the selection, in the order things were
 * added: every chosen item becomes a slug — packages included, so one booking
 * carries every chosen bundle — and each listing that is bookable at all is
 * pre-filled to quantity 1 via `?q_<id>=1` (a package needs no pre-fill: its
 * count selector already defaults to one bundle). Sold-out picks still show on
 * the booking page as slugs without a pre-fill, and NOTHING selected is
 * dropped — the booking page and its submit are the availability authority.
 * The chosen date rides along as `?date=` so daily items land pre-dated.
 * Returns null when no selected key names a catalog item at all (a
 * hand-crafted query of unknown ids) — there is nothing to book, so the
 * caller falls through to the gallery.
 */
const bookingUrlFor = (
  catalog: OrderCatalog,
  selectedKeys: string[],
  date: string | null,
): string | null => {
  const listingById = new Map(
    catalog.ticketListings.map((info) => [info.listing.id, info]),
  );
  const packageByGroupId = new Map(
    catalog.packages.map((pkg) => [pkg.group.id, pkg]),
  );
  const chosen = compact(
    selectedKeys.map((key) => {
      const [kind = "", rawId = ""] = key.split(":");
      const id = Number(rawId);
      if (kind === "listing") {
        const info = listingById.get(id);
        return info === undefined
          ? null
          : {
              prefill:
                !info.isSoldOut && !info.isClosed && info.maxPurchasable >= 1
                  ? `q_${info.listing.id}=1`
                  : null,
              slug: info.listing.slug,
            };
      }
      const pkg = packageByGroupId.get(id);
      return pkg === undefined ? null : { prefill: null, slug: pkg.group.slug };
    }),
  );
  if (chosen.length === 0) return null;
  const query = [
    ...compact(chosen.map((item) => item.prefill)),
    ...(date === null ? [] : [`date=${date}`]),
  ];
  return `/ticket/${chosen.map((item) => item.slug).join("+")}${
    query.length > 0 ? `?${query.join("&")}` : ""
  }`;
};

/** The order handlers' shared preamble: the availability gate, then the
 * loaded catalog and the request's evaluation handed to the handler body. */
const withEvaluatedOrder =
  (
    handle: ResponseHandler<
      [catalog: OrderCatalog, evaluation: OrderEvaluation]
    >,
  ) =>
  async (request: Request): Promise<Response> => {
    const blocked = orderUnavailable();
    if (blocked) return blocked;
    const catalog = await loadOrderCatalog();
    const params = new URL(request.url).searchParams;
    return handle(catalog, await evaluateRequest(catalog, params));
  };

/**
 * GET /order — render the gallery, or (when the cart carried a selection)
 * redirect into the pre-filled booking page.
 */
const handleOrder = withEvaluatedOrder(async (catalog, evaluation) => {
  const bookingUrl = bookingUrlFor(
    catalog,
    evaluation.selectedKeys,
    evaluation.date,
  );
  if (bookingUrl !== null) return redirectResponse(bookingUrl);

  const attributesByListing = await getSelectedAttributesForListings(
    catalog.ticketListings.map((info) => info.listing.id),
  );
  return htmlResponse(
    orderGalleryPage(
      catalog.ticketListings,
      catalog.packages,
      {
        anyNeedsDate: catalog.options.some((option) => option.needsDate),
        // The evaluator judges every option, and cards render only options.
        labelFor: (key) => stateLabel(evaluation.states.get(key)!),
      },
      await publicNavProps(null),
      settings.websiteTitle,
      settings.orderIntroText || null,
      attributesByListing,
    ),
  );
});

/**
 * GET /order/availability — the live evaluation behind the gallery's greying,
 * as JSON keyed by option key. It reveals nothing the gallery doesn't already
 * show: only rendered options are judged, no numbers are returned, and a
 * "blocked" label only ever names an item the visitor themselves selected.
 */
const handleOrderAvailability = withEvaluatedOrder((_catalog, evaluation) => {
  const states: Record<string, { state: string; label: string }> = {};
  for (const [key, state] of evaluation.states) {
    states[key] = { label: stateLabel(state), state: state.kind };
  }
  return jsonResponse({ dateNeeded: evaluation.dateNeeded, states });
});

/** Route public order requests. */
export const routeOrder = createRouter(
  defineRoutes({
    "GET /order": handleOrder,
    "GET /order/availability": handleOrderAvailability,
  }),
);
