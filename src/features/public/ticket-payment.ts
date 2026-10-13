/** Paid payment flow, availability checks, and the booking page context. */

import { intersect } from "@std/collections";
import { type BuildTreeInput, buildBookingTree } from "#booking/build-tree.ts";
import {
  type FoldBase,
  type FoldChildrenResult,
  foldBookingTree,
  resolvedByNodeKey,
} from "#booking/fold-tree.ts";
import type { TicketListing } from "#booking/model.ts";
import {
  buildPagePackage,
  combinedPackageTerms,
  explicitStandaloneIds,
  type PagePackage,
} from "#booking/page-packages.ts";
import type { BookingTree } from "#booking/tree.ts";
import type { LineBooking } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { getDatelessGroupRemaining } from "#db/attendees/capacity/groups.ts";
import { listingGroups } from "#db/groups/table.ts";
import { loadPackageMemberPricingByGroupIds } from "#db/groups.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import { getImageFilenamesForItem } from "#db/images.ts";
import {
  getOptionalAddOns,
  hasPromoCodeModifiers,
} from "#db/modifier-resolve.ts";
import { getQuestionsWithListingIds } from "#db/questions/queries.ts";
import { settings } from "#db/settings.ts";
import { requiredMapValue } from "#fp";
import { checkoutResponse } from "#routes/payment-response.ts";
import { errorRedirect } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
/* jscpd:ignore-start */
import { bookingDateFields } from "#shared/booking-date-fields.ts";
import type { FormParams } from "#shared/form-data.ts";
import { logDebug } from "#shared/logger.ts";
import {
  type CheckoutIntent,
  getActivePaymentProvider,
} from "#shared/payments.ts";
import { requireValue } from "#shared/required-value.ts";
import type { Group } from "#types";
import {
  buildChildDatesById,
  dailyDateItems,
  keepDatesSomeChildCanServe,
  keepPackageDatesChildrenCanServe,
  singleDailyParent,
} from "./booking-dates.ts";
import { childListingIdsOf, loadChildrenByParentId } from "./child-listings.ts";
import { judgeSubmittedCart } from "./judge-cart.ts";
import { listingsWithQuantity } from "./ticket-form.ts";
import { ticketPageUrl } from "./ticket-page-url.ts";
import type {
  ChildrenByParentId,
  ListingQty,
  TicketCtx,
  TicketSharedContext,
} from "./types.ts";
/* jscpd:ignore-end */

/** Redirect to checkout, or return the handler's error.
 * In iframe mode returns a popup page instead of a redirect: Stripe cannot run in iframes. */
export const tryCheckoutRedirect = <T>(
  sessionUrl: string | undefined | null,
  errorHandler: () => T,
): Response | T => {
  if (!sessionUrl) return errorHandler();
  return checkoutResponse(sessionUrl);
};

/** Get active payment provider or return an error response */
export const withPaymentProvider = async (
  onMissing: () => Response,
  fn: (
    provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object,
  ) => Promise<Response>,
): Promise<Response> => {
  const provider = await getActivePaymentProvider();
  return provider ? fn(provider) : onMissing();
};

/** Generic checkout flow: resolve provider, create session, redirect or show error.
 * In iframe mode opens checkout in a popup window instead of a redirect. */
export const runCheckoutFlow = (
  label: string,
  request: Request,
  intent: CheckoutIntent,
  onError: (msg: string, status: number) => Response,
): Promise<Response> => {
  logDebug("Payment", `Starting ${label} checkout`);
  return withPaymentProvider(
    () => {
      logDebug(
        "Payment",
        `No payment provider configured for ${label} checkout`,
      );
      return onError(
        "Payments are not configured. Please contact the administrator.",
        500,
      );
    },
    async (provider) => {
      logDebug("Payment", `Using provider=${provider.type} for ${label}`);
      const baseUrl = getBaseUrl(request);
      logDebug("Payment", `Creating checkout session baseUrl=${baseUrl}`);
      const result = await provider.createCheckoutSession(intent, baseUrl);
      if (result && "error" in result) {
        logDebug(
          "Payment",
          `Checkout validation error for ${label}: ${result.error}`,
        );
        return onError(result.error, 400);
      }
      logDebug(
        "Payment",
        `Checkout result for ${label}: ${
          result ? `url=${result.checkoutUrl}` : "null"
        }`,
      );
      return tryCheckoutRedirect(result?.checkoutUrl, () => {
        logDebug(
          "Payment",
          `Checkout redirect failed for ${label}: no session URL`,
        );
        return onError(
          "Failed to create payment session. Please try again.",
          500,
        );
      });
    },
  );
};

/** Whether all selected listings have available spots (one batched query). */
export const checkAvailability = (
  listings: TicketListing[],
  quantities: Map<number, number>,
  date?: string | null,
  dayCount = 1,
): Promise<boolean> =>
  attendeesApi.checkBatchAvailability(
    buildBookings(
      listingsWithQuantity(listings, quantities),
      date ?? null,
      dayCount,
    ),
    date,
  );

/** One package on a booking page: the group, and the members that survived the
 * page's own drops. */
export type PagePackageEntry = {
  group: Group;
  memberListingIds: readonly number[];
};

/** Load every listed package's pricing in one batch and shape each into the
 * {@link PagePackage} the booking flow carries — the group's display fields
 * plus its member quantity/price maps, scoped to the members actually on the
 * page. A cart naming many packages costs the same two reads as one. */
export const loadPagePackages = async (
  entries: readonly PagePackageEntry[],
): Promise<PagePackage[]> => {
  const pricingByGroup = await loadPackageMemberPricingByGroupIds(
    entries.map((entry) => entry.group.id),
  );
  return entries.map((entry) =>
    buildPagePackage(
      entry.group,
      entry.memberListingIds,
      requiredMapValue(
        pricingByGroup,
        entry.group.id,
        "Missing package pricing",
      ),
    ),
  );
};

/** One group's page package, through the shared many-package path. */
export const loadPagePackage = async (
  group: Group,
  memberListingIds: readonly number[],
): Promise<PagePackage> =>
  requireValue(
    (await loadPagePackages([{ group, memberListingIds }]))[0],
    `Missing page package for group ${group.id}`,
  );

export const handlePaymentFlow = (
  request: Request,
  intent: CheckoutIntent,
  ctx: TicketCtx,
): Promise<Response> =>
  runCheckoutFlow(
    `ticket items=${intent.items.length}`,
    request,
    intent,
    (msg) => errorRedirect(ticketPageUrl(ctx), msg),
  );

const buildBookings = (
  selected: ListingQty[],
  date: string | null,
  dayCount: number,
): LineBooking[] =>
  selected.map(({ listing, qty }) => ({
    listingId: listing.id,
    quantity: qty,
    ...bookingDateFields(listing, date, dayCount),
  }));

/** Build the pure {@link BuildTreeInput} from a resolved ticket context, so the
 * fold walks the same canonical tree render builds. Each page package's members
 * build as that package's FIXED/override member nodes — plus a standalone node
 * when the cart also added the member by its own slug — and every other listing
 * as a standalone node (a regular group carries no id on the ctx yet, so its
 * members build as standalone listing nodes — identical fold field names). */
export const ctxToBuildTreeInput = (ctx: TicketCtx): BuildTreeInput => ({
  childrenByParentId: ctx.childrenByParentId,
  listings: ctx.listings,
  packages: ctx.packages,
  slugs: ctx.slugs,
  standaloneListingIds: explicitStandaloneIds(
    ctx.listings.map((info) => info.listing),
    ctx.packages,
    ctx.slugs,
  ),
});

/**
 * Fold every in-cart parent's selected children into the order by building the
 * canonical {@link BookingTree} from the
 * resolved context and handing it to the pure {@link foldBookingTree} walk — so a
 * package member, a group member and a standalone parent all fold through one
 * recursive tree walk. Returns the expanded listing set + quantity/custom-price
 * maps + per-(child, parent) allocations (same shape the callers already
 * consume). Holidays are fetched once, and only when a parent with
 * children is actually in the cart (a daily child validates the resolved date
 * against its own calendar).
 */
export const foldSelectedChildren = async (
  ctx: TicketCtx,
  form: FormParams,
  base: FoldBase,
  prebuiltTree?: BookingTree,
): Promise<FoldChildrenResult> => {
  // A caller that already built the ctx's tree (the API book path builds it
  // for the cap) passes it in rather than walking the graph twice per request.
  const tree = prebuiltTree ?? buildBookingTree(ctxToBuildTreeInput(ctx));
  const resolved = resolvedByNodeKey(
    ctx.listings,
    ctx.childrenByParentId,
    tree,
  );
  const hasFoldableParent = tree.nodes.some(
    (node) =>
      node.children.length > 0 &&
      (base.quantities.get(node.listingId) ?? 0) > 0,
  );
  if (!hasFoldableParent)
    return foldBookingTree(tree, resolved, form, base, []);
  const holidays = await getActiveHolidays();
  // The submitted cart asks the one judge first: an option the form cannot
  // book refuses here, before the walk prices it. Capacity stays with the
  // walk and the checkout's SQL.
  const verdict = judgeSubmittedCart({ base, ctx, form, holidays });
  if (!verdict.ok) return { error: verdict.error, ok: false };
  return foldBookingTree(tree, resolved, form, base, holidays);
};

/** Group info needed to check a package's whole-package limit. */
export const loadPackageLimitGroupMaps = async (
  members: TicketListing[],
  childrenByParentId: ChildrenByParentId,
): Promise<{
  groupIdsByListingId: Map<number, number[]>;
  groupRemainingByGroupId: ReadonlyMap<number, number>;
}> => {
  const limitListings = [
    ...members.map((e) => e.listing),
    ...[...childrenByParentId.values()].flat().map((e) => e.listing),
  ];
  const groupIdsByListingId = await listingGroups.getIdsByKeys(
    limitListings.map((l) => l.id),
  );
  return {
    groupIdsByListingId,
    groupRemainingByGroupId: await getDatelessGroupRemaining(
      limitListings,
      groupIdsByListingId,
    ),
  };
};

/** The page header whose gallery is shown: a group takes priority, otherwise a
 * sole listing supplies the header. A multi-listing page has no one gallery. */
export const ticketGalleryTarget = (
  activeListings: readonly TicketListing[],
  group?: Group,
): TicketSharedContext["galleryTarget"] => {
  if (group) return { id: group.id, type: "group" };
  if (activeListings.length === 1) {
    return { id: activeListings[0]!.listing.id, type: "listing" };
  }
  return null;
};

const ticketPageHidden = (listings: TicketListing[], group?: Group): boolean =>
  group?.hidden ?? listings.some(({ listing }) => listing.hidden);

const pageHiddenFor = (
  activeListings: TicketListing[],
  group: Group | undefined,
  roots: readonly { hidden: boolean }[] | undefined,
): boolean =>
  roots === undefined
    ? ticketPageHidden(activeListings, group)
    : roots.some((root) => root.hidden);

export const getTicketContext = async (
  activeListings: TicketListing[],
  group?: Group,
  pagePackages?: PagePackage[],
  // A mixed cart passes its selected package groups and standalone listings
  // explicitly: the packages' expanded members must not decide the robots
  // policy for the roots the visitor actually chose.
  roots?: readonly { hidden: boolean }[],
): Promise<TicketSharedContext> => {
  const listingIds = activeListings.map((e) => e.listing.id);
  const childrenByParentId = await loadChildrenByParentId(activeListings);
  // Child questions must be parseable/validatable at submit, so load questions for
  // the children's listing ids too (a child question activates for its child line
  // in the fold).
  const questionListingIds = [
    ...listingIds,
    ...childListingIdsOf(childrenByParentId),
  ];
  const [
    cartDateItems,
    globalTerms,
    questionsResult,
    promoCodesEnabled,
    addOns,
    groupImage,
  ] = await Promise.all([
    dailyDateItems(activeListings),
    Promise.resolve(settings.terms),
    getQuestionsWithListingIds(questionListingIds),
    hasPromoCodeModifiers(),
    getOptionalAddOns(listingIds),
    group ? getImageFilenamesForItem("group", group.id) : undefined,
  ]);
  // The header entity whose image gallery the page renders: the group on a
  // group page, or the sole listing on a single-listing page (a multi-listing
  // combo has no single header). Just the reference here — the images are read
  // lazily on the render path only (renderCtx), so submit/quote/API pay nothing.
  const galleryTarget = ticketGalleryTarget(activeListings, group);
  // A daily parent's offered dates must intersect the union of its children's
  // bookable dates; the client compatibility script also needs each
  // daily child's serveable dates. Both are holiday-aware, so fetch
  // holidays once when the page has any parents; pages with none skip it entirely.
  const holidays = childrenByParentId.size > 0 ? await getActiveHolidays() : [];
  // The page's bundles: a mixed cart passes its already-loaded packages in; a
  // single-group package page builds its one PagePackage from the group ("a
  // single item is an array of one"). Loaded once here so quote and submit
  // price/derive against the same maps with no extra query.
  const packages =
    pagePackages ??
    (group?.is_package === true
      ? [await loadPagePackage(group, listingIds)]
      : []);
  // The dates the page can offer start from what EVERY daily listing supports.
  const sharedDates = intersect(...cartDateItems.map((item) => item.dates));
  const dailyParent = singleDailyParent(activeListings, childrenByParentId);
  const dates = dailyParent
    ? keepDatesSomeChildCanServe(sharedDates, dailyParent.children, {
        fixedDays: dailyParent.fixedDays,
        holidays,
      })
    : packages.length > 0
      ? keepPackageDatesChildrenCanServe(
          activeListings,
          childrenByParentId,
          sharedDates,
          holidays,
        )
      : sharedDates;
  const childDatesById = buildChildDatesById(
    activeListings,
    childrenByParentId,
    holidays,
  );
  // A group page's own terms win; a cart shows every selected package's terms.
  const terms = group
    ? group.terms_and_conditions || globalTerms || ""
    : combinedPackageTerms(packages, globalTerms || "");
  const packageCapMaps =
    packages.length > 0
      ? await loadPackageLimitGroupMaps(activeListings, childrenByParentId)
      : {
          groupIdsByListingId: new Map<number, number[]>(),
          groupRemainingByGroupId: new Map<number, number>(),
        };
  return {
    addOns,
    cartDateItems,
    childDatesById,
    childrenByParentId,
    dates,
    galleryImages: [],
    galleryTarget,
    packageGroupRemainingByGroupId: packageCapMaps.groupRemainingByGroupId,
    packageMemberGroupIds: packageCapMaps.groupIdsByListingId,
    packages,
    pageHidden: pageHiddenFor(activeListings, group, roots),
    promoCodesEnabled,
    terms,
    ...questionsResult,
    ...(group && {
      groupDescription: group.description,
      groupImage: groupImage!,
      groupName: group.name,
    }),
  };
};
