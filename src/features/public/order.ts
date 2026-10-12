/**
 * Selection, the count, and the cart are pure CSS (`:checked`, a counter and
 * `:has()`), so the page works with no JavaScript. A script only keeps
 * availability live on top of that.
 *
 * The page is advisory: the booking form stays the authority. An option's
 * demand covers its direct listings and the child units the form auto-folds.
 * Two selections that contend for one child pool therefore show the conflict
 * the form refuses.
 */

/* jscpd:ignore-start -- imports */
import {
  groupRemainingFromSnapshot,
  loadCapacitySnapshot,
  remainingFromSnapshot,
} from "#db/attendees/capacity/snapshot.ts";
import { getSelectedAttributesForListings } from "#db/attributes.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import { settings } from "#db/settings.ts";
import { compact, uniqueBy } from "#fp";
import { t } from "#i18n";
import {
  htmlResponse,
  jsonResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { evaluateOrder } from "#shared/order/evaluate.ts";
import type { OrderOptionState, OrderPools } from "#shared/order/options.ts";
import {
  orderedSelectionKeys,
  selectedStartDate,
} from "#shared/order-select.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { orderGalleryPage } from "#templates/public/order-gallery.tsx";
import type { ListingWithCount } from "#types";
import { loadOrderCatalog, type OrderCatalog } from "./order-catalog.ts";
import { publicNavProps } from "./site-nav.ts";

/* jscpd:ignore-end */

/**
 * Guard: the order page is available only when the public site is on and the
 * owner has enabled it. Returns a Response to short-circuit, or null to proceed
 * — redirecting to admin login when the whole public site is off (as the other
 * public pages do) and 404ing when only the order page is disabled.
 */
const orderUnavailable = (): Response | null => {
  if (!settings.features.site) return redirectResponse("/admin/login");
  if (!settings.orderEnabled) return notFoundResponse();
  return null;
};

/** The span a listing's booking occupies from a chosen start date: a fixed
 * daily listing books its whole duration (capacity must hold on EVERY day); a
 * customisable one is judged at its shortest bookable span (the gallery can't
 * know the buyer's choice yet); everything else is dateless. */
const bookingSpanDays = (listing: ListingWithCount): number =>
  listing.listing_type === "daily" && !listing.customisable_days
    ? Math.max(1, listing.duration_days)
    : 1;

/** The widest span any of a group's listings would occupy, so its cap is
 * judged over every day one of them could take up. */
const widestSpanPerGroup = (
  involved: ListingWithCount[],
  groupIdsByListingId: Map<number, number[]>,
  spanOf: (listing: ListingWithCount) => number,
): Map<number, number> => {
  const spanByGroupId = new Map<number, number>();
  for (const listing of involved) {
    for (const groupId of listingGroups.idsFor(
      groupIdsByListingId,
      listing.id,
    )) {
      spanByGroupId.set(
        groupId,
        Math.max(spanOf(listing), spanByGroupId.get(groupId) ?? 1),
      );
    }
  }
  return spanByGroupId;
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
    // The folded children join the pools: their remaining (and their groups'
    // remaining) is what the folded demand draws from.
    ...catalog.childListings,
  ]);
  const groupIdsByListingId = await listingGroups.getIdsByKeys(
    involved.map((listing) => listing.id),
  );
  const spanOf = (listing: ListingWithCount): number =>
    date === null ? 1 : bookingSpanDays(listing);
  const spanByGroupId = widestSpanPerGroup(
    involved,
    groupIdsByListingId,
    spanOf,
  );
  const [snapshot, holidays] = await Promise.all([
    loadCapacitySnapshot(
      involved,
      date,
      Math.max(1, ...involved.map(spanOf)),
      groupIdsByListingId,
    ),
    date === null ? Promise.resolve([]) : getActiveHolidays(),
  ]);
  const remainingByListingId = remainingFromSnapshot(
    snapshot,
    involved,
    spanOf,
  );
  const remainingByGroupId = groupRemainingFromSnapshot(
    snapshot,
    spanByGroupId,
  );
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
 * NOTHING selected is dropped, not even a sold-out pick. The booking page and
 * its submit are the availability authority, so a sold-out slug goes through
 * without a pre-fill and never disappears.
 *
 * A package needs no `?q_` pre-fill: its count selector already defaults to one
 * bundle. Returns null when no selected key names a catalog item at all.
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
                !info.isSoldOut &&
                !info.isClosed &&
                info.maxPurchasable >= info.listing.min_quantity
                  ? `q_${info.listing.id}=${info.listing.min_quantity}`
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
