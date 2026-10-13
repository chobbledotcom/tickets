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
  datelessRemainingFromSnapshot,
  judgedByDay,
  loadCapacitySnapshot,
  perDayRemainingFromSnapshot,
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
import { evaluateOrder } from "#shared/order/evaluate.ts";
import type {
  OrderOption,
  OrderOptionState,
  OrderPools,
} from "#shared/order/options.ts";
import {
  orderedSelectionKeys,
  selectedStartDate,
} from "#shared/order-select.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { orderGalleryPage } from "#templates/public/order-gallery.tsx";
import type { ListingWithCount } from "#types";
import {
  judgeOrderOptions,
  loadOrderCatalog,
  type OrderCatalog,
} from "./order-catalog.ts";
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

/** The capacity pools the evaluator draws from, resolved for the chosen date
 * (or datelessly when none is chosen): every involved listing's remaining and
 * every capped group's remaining — per day for the listings and groups judged
 * by day, as a running total otherwise — so demand two selections place on a
 * shared pool adds up. One snapshot covers every span the options' judged
 * demand occupies, and each option is judged over its own span. */
const loadOrderPools = async (
  catalog: OrderCatalog,
  options: readonly OrderOption[],
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
  const widestSpanDays = Math.max(
    1,
    ...options.flatMap((option) => [...option.spanDaysByListingId.values()]),
  );
  const snapshot = await loadCapacitySnapshot(
    involved,
    date,
    widestSpanDays,
    groupIdsByListingId,
  );
  const dateless = involved.filter(
    (listing) => !judgedByDay(listing, snapshot),
  );
  return {
    days: snapshot.days,
    groupIdsByListingId,
    remainingByGroupDay: snapshot.groupByDay,
    remainingByGroupId: snapshot.datelessGroupRemaining,
    remainingByListingDay: perDayRemainingFromSnapshot(snapshot, involved),
    remainingByListingId: datelessRemainingFromSnapshot(
      dateless,
      snapshot,
    ),
  };
};

type OrderEvaluation = {
  states: Map<string, OrderOptionState>;
  selectedKeys: string[];
  date: string | null;
  /** Whether any option can only be judged once a date is chosen. */
  anyNeedsDate: boolean;
  dateNeeded: boolean;
};

/** Evaluate the request's selection against the catalog. */
const evaluateRequest = async (
  catalog: OrderCatalog,
  params: URLSearchParams,
): Promise<OrderEvaluation> => {
  const date = selectedStartDate(params) || null;
  const selectedKeys = orderedSelectionKeys(params);
  // The judge reads holidays only when a date is chosen; without one it
  // answers in the form's render phase, which is date-less.
  const holidays = date === null ? [] : await getActiveHolidays();
  const options = judgeOrderOptions(catalog, date, holidays);
  const pools = await loadOrderPools(catalog, options, date);
  const states = evaluateOrder(options, pools, selectedKeys, date !== null);
  // The date prompt fires when a chosen item can't be judged without one.
  const dateNeeded =
    date === null &&
    selectedKeys.some((key) =>
      options.some((option) => option.key === key && option.needsDate),
    );
  return {
    anyNeedsDate: options.some((option) => option.needsDate),
    date,
    dateNeeded,
    selectedKeys,
    states,
  };
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
        anyNeedsDate: evaluation.anyNeedsDate,
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
