import { apiError, apiResponse } from "#routes/api/cors.ts";
import {
  applyChildSelectionsToForm,
  completeFoldedBooking,
  foldChildrenOrError,
  parseApiChildSelections,
  validateFoldedFields,
} from "#routes/api/folded-booking.ts";
import {
  checkBookingRateLimit,
  parseApiJsonBody,
  resolvePositiveQuantity,
  toFormParams,
  withSlugLoaded,
} from "#routes/api/helpers.ts";
import { resolvedToPublicListing } from "#routes/api/public-listing.ts";
import {
  type ApiChildSelection,
  PackageChildrenSchema,
} from "#routes/api/request-schemas.ts";
import { loadBookablePackageBySlug } from "#routes/public/groups.ts";
import { listingsWithQuantity } from "#routes/public/ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "#routes/public/ticket-listings.ts";
import {
  ctxStandInNames,
  ctxToBuildTreeInput,
  getTicketContext,
  resolveDayCount,
} from "#routes/public/ticket-payment.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import type { ServerContext } from "#routes/types.ts";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import { bookingError } from "#shared/booking/form.ts";
import {
  bookableChildIds,
  packageDayCountsChildrenSupport,
} from "#shared/booking/model.ts";
import {
  buildOrderLines,
  nodeQuantitiesFor,
} from "#shared/booking/order-lines.ts";
import {
  packageBundleLimit,
  packageLimitInfo,
} from "#shared/booking/package-cap.ts";
import { packageBundleTotal } from "#shared/booking/price-tree.ts";
import {
  type BookingTree,
  fixedQuantitiesByListingId,
} from "#shared/booking/tree.ts";
import { getAvailableDates } from "#shared/dates.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import type { FormParams } from "#shared/form-data.ts";
import { mergeListingFields } from "#shared/listing-fields.ts";
import {
  concealLineNames,
  namesConcealed,
  packagePrivacy,
} from "#shared/package-privacy.ts";
import type { Group } from "#shared/types.ts";
import { extractContact } from "#templates/fields/ticket.ts";

const PACKAGE_NOT_FOUND = "Package not found";

/** The ctx, group, limit, and tree a package endpoint needs once its slug
 * resolves to a bookable bundle — the loaded shape {@link withPackageContext}
 * hands to both the GET (detail) and POST (book) handlers. */
type PackageContext = {
  ctx: TicketCtx;
  group: Group;
  limit: number;
  tree: BookingTree;
};

/** Loads a package only when at least one whole package can still be booked. */
const loadPackageContext = async (
  slug: string,
): Promise<PackageContext | null> => {
  const loaded = await loadBookablePackageBySlug(slug);
  if (!loaded) return null;
  const ticketListings = await buildTicketListingsWithGroupCapacity(
    loaded.listings,
  );
  const sharedCtx = await getTicketContext(ticketListings, loaded.group);
  const ctx: TicketCtx = {
    ...sharedCtx,
    listings: ticketListings,
    slugs: [slug],
  };
  const tree = buildBookingTree(ctxToBuildTreeInput(ctx));
  const limit = packageBundleLimit(
    tree,
    packageLimitInfo(
      ticketListings,
      ctx.childrenByParentId,
      ctx.packageGroupRemainingByGroupId,
      ctx.packageMemberGroupIds,
    ),
  );
  return { ctx, group: loaded.group, limit, tree };
};

/** Load a bookable package context by slug, or respond with the
 * package-not-found 404. Used by the GET detail handler via
 * {@link withPackageContext}; the POST book handler loads directly so it can
 * rate-limit BEFORE the expensive package load (the unauthenticated flood
 * guard must reject a limited IP without building a package tree). */
const loadPackageContextOr404 = async (
  slug: string,
): Promise<PackageContext | Response> =>
  (await loadPackageContext(slug)) ?? apiError(PACKAGE_NOT_FOUND, 404);

/** Load a bookable package by slug, or respond with the package-not-found 404 —
 * shared by the GET and POST package endpoints via {@link withSlugLoaded} so the
 * load-or-404 block never drifts between them. */
const withPackageContext = withSlugLoaded<PackageContext>(
  loadPackageContextOr404,
);

/** The contact-field requirement a package booking can validate against: the
 * members' settings merged with their children's (a chosen add-on can add a
 * field). Published as one package-level value, so an API client — which cannot
 * see a hidden package's members through the listing API — knows what to submit
 * before POSTing. */
const packageMergedFields = (ctx: TicketCtx): string =>
  mergeListingFields(
    ctx.listings.flatMap((e) => [
      e.listing.fields,
      ...(ctx.childrenByParentId.get(e.listing.id) ?? []).map(
        (c) => c.listing.fields,
      ),
    ]),
  );

/** GET /api/packages/:slug — package bundle detail. A fixed-price bundle
 * reports one `priceMinor`; a customisable one reports each offered day count
 * with its whole-bundle total (only counts every member's required-child mix
 * can serve — an empty list means no span is currently bookable). A HIDDEN
 * package omits its members entirely. */
export const handleGetPackage = withPackageContext(
  async (_request, { ctx, group, limit, tree }) => {
    const customisable = ctx.listings.some((e) => e.listing.customisable_days);
    const dayCounts = customisable
      ? packageDayCountsChildrenSupport(ctx.listings, ctx.childrenByParentId)
      : [];
    // A hidden package never names its members (or their children) — buyers see
    // only the bundle. `packageQuantities` covers every member by construction.
    // Members and their children are already availability-resolved on the ctx
    // (ONE hydration pass), so the response is built without re-querying edges,
    // holidays, or group remaining per member.
    const holidays = await getActiveHolidays();
    const memberQuantities = fixedQuantitiesByListingId(tree);
    const bookableChildren = bookableChildIds(ctx.childrenByParentId);
    const members = namesConcealed(
      packagePrivacy(group.hide_package_listings, group.name),
    )
      ? undefined
      : ctx.listings.map((e) => {
          const children = (ctx.childrenByParentId.get(e.listing.id) ?? [])
            .filter((child) => child.listing.active)
            .map((child) =>
              resolvedToPublicListing(
                child,
                child.listing.listing_type === "daily"
                  ? getAvailableDates(child.listing, holidays)
                  : undefined,
              ),
            );
          return {
            name: e.listing.name,
            quantity: memberQuantities.get(e.listing.id)!,
            slug: e.listing.slug,
            ...(children.length > 0 ? { children } : {}),
          };
        });
    return apiResponse({
      package: {
        description: group.description,
        fields: packageMergedFields(ctx),
        maxPurchasable: limit,
        name: group.name,
        slug: group.slug,
        ...(ctx.dates.length > 0 ? { availableDates: ctx.dates } : {}),
        ...(customisable
          ? {
              dayCounts: dayCounts.map((days) => ({
                days,
                priceMinor: packageBundleTotal(tree, days, bookableChildren),
              })),
            }
          : { priceMinor: packageBundleTotal(tree, 1, bookableChildren) }),
        ...(members ? { members } : {}),
      },
    });
  },
);

/** Apply a package booking's child selections (each tagged with its member's
 * `parent` slug) onto the fold form, member by member. Returns a 400 response
 * for an unknown member slug or a bad selection; null when applied cleanly. */
const applyPackageChildSelections = (
  form: FormParams,
  ctx: TicketCtx,
  selections: ApiChildSelection[],
): Response | null => {
  const byParent = Map.groupBy(selections, (s) => s.parent!);
  for (const [parentSlug, perParent] of byParent) {
    const member = ctx.listings.find((e) => e.listing.slug === parentSlug);
    if (!member) {
      return apiError(`'${parentSlug}' is not a member of this package.`);
    }
    const error = applyChildSelectionsToForm(
      form,
      ctx,
      member.listing.id,
      perParent,
    );
    if (error) return error;
  }
  return null;
};

/** Reads a package API booking body and builds the form the booking flow uses. */
const resolvePackageOrder = async (
  body: Record<string, unknown>,
  ctx: TicketCtx,
  tree: BookingTree,
  limit: number,
  standIns: ReadonlyMap<number, string>,
): Promise<
  | Response
  | {
      date: string | null;
      dayCount: number;
      form: FormParams;
      packageQty: number;
      quantities: Map<number, number>;
    }
> => {
  const requestedQty = resolvePositiveQuantity(body);
  if (requestedQty instanceof Response) return requestedQty;
  const packageQty = Math.min(requestedQty, limit);
  const quantities = new Map(
    [...fixedQuantitiesByListingId(tree)].map(([listingId, fixed]) => [
      listingId,
      fixed * packageQty,
    ]),
  );

  let date: string | null = null;
  if (ctx.dates.length > 0) {
    const submitted = String(body.date ?? "");
    if (!ctx.dates.includes(submitted)) {
      return apiError(bookingError.invalidDate);
    }
    date = submitted;
  }

  const form = toFormParams(body);
  if (body.dayCount !== undefined) {
    form.set("day_count", String(body.dayCount));
  }
  const dayResult = await resolveDayCount(
    listingsWithQuantity(ctx.listings, quantities),
    form,
    date,
    standIns,
  );
  if ("error" in dayResult) {
    return apiError(dayResult.error);
  }
  return { date, dayCount: dayResult.dayCount, form, packageQty, quantities };
};

/** POST /api/packages/:slug/book — book whole bundles. The body carries the
 * contact fields plus `quantity` (package count, default 1), `date` for a dated
 * package, `dayCount` for a customisable one, and `children` — entries of
 * `{ parent, slug, quantity }` choosing each parent member's add-ons — all
 * driving the SAME context, clamp, fold, and pricing walk the web package page
 * submits through. */
export const handleBookPackage = async (
  request: Request,
  { slug }: { slug: string },
  server?: ServerContext,
): Promise<Response> => {
  // Rate-limit BEFORE the package load: the booking endpoints are
  // unauthenticated, so the flood guard must reject a limited IP without
  // building a package tree. The standalone listing book path loads the listing
  // first (its load is a single slug lookup), but a package load builds a full
  // ctx/tree/limit graph, so guarding it behind the limiter matters more here.
  const limited = await checkBookingRateLimit(request, server);
  if (limited) return limited;
  const pkg = await loadPackageContextOr404(slug);
  if (pkg instanceof Response) return pkg;
  const { ctx, group, limit, tree } = pkg;

  const body = await parseApiJsonBody(request);
  if (body instanceof Response) return body;

  const standIns = ctxStandInNames(ctx);
  const order = await resolvePackageOrder(
    body,
    ctx,
    tree,
    limit,
    standIns.byListingId,
  );
  if (order instanceof Response) return order;
  const { date, dayCount, form, packageQty, quantities } = order;

  const selections = parseApiChildSelections(body, PackageChildrenSchema);
  if (selections === null) {
    return apiError(
      "Provide a `children` array of { parent, slug, quantity } choosing each member's add-ons.",
    );
  }
  const selectionError = applyPackageChildSelections(form, ctx, selections);
  if (selectionError) return selectionError;

  const fold = await foldChildrenOrError(
    ctx,
    form,
    {
      customPrices: new Map(),
      date,
      dayCount,
      hasCustomisable: ctx.listings.some((e) => e.listing.customisable_days),
      quantities,
    },
    tree,
  );
  if (fold instanceof Response) return fold;

  // Per-path lines from the tree: each member line carries its group id and
  // its override price; a HIDDEN package's member names are concealed before
  // the lines reach the provider. Paid-ness must come from these lines, not
  // `isPaidListing`: a package override can make a free member paid (and a
  // paid member free).
  const items = concealLineNames(
    buildOrderLines(
      tree,
      nodeQuantitiesFor(tree, new Map(), new Map([[group.id, packageQty]])),
      fold.quantities,
      fold.customPrices,
      fold.dayCount,
    ),
    standIns,
  );
  const valResult = validateFoldedFields(
    form,
    fold,
    items.some((item) => item.unitPrice > 0),
  );
  if (valResult instanceof Response) return valResult;
  return completeFoldedBooking(request, {
    contact: extractContact(valResult),
    date,
    fold,
    items,
  });
};
