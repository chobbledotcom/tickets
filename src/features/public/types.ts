/**
 * Shared types, constants, and tiny utilities for public ticket routes
 */

import type {
  ChildDatesByDayCount,
  TicketListing,
} from "#shared/booking/model.ts";
import type { PagePackage } from "#shared/booking/page-packages.ts";
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import type { QuestionListingMap } from "#shared/db/questions/queries.ts";
import type {
  Image,
  ImageUseItemType,
  ItemImageProjection,
  ListingWithCount,
} from "#shared/types.ts";
import type { BookingPrefill } from "#templates/public/reservations/inputs.ts";

/** Parent listing id → its bookable-child candidates, each hydrated to a
 * {@link TicketListing} so availability (isSoldOut/isClosed/maxPurchasable) is
 * resolved for the gate/render. Empty when the parents flag is off or the page
 * has no parents; children are never added to `ctx.listings` (they are not URL
 * slugs). */
export type ChildrenByParentId = Map<number, TicketListing[]>;

/** Ticket shared context shape */
export type TicketSharedContext = {
  dates: string[];
  terms: string;
  questions: QuestionWithAnswers[];
  questionListingMap: QuestionListingMap;
  /** Parent→children relationship for the page's listings (see
   * {@link ChildrenByParentId}); empty map when the flag is off or none apply. */
  childrenByParentId: ChildrenByParentId;
  /** Each DAILY child's holiday-aware serveable start dates, keyed by the
   * (parent, child) PAIR (`childDateKey`) so a child required by two parents
   * carries each parent's own dates; emitted as `data-child-dates` for
   * the client compatibility script; empty map when the page has no
   * daily children. Per selectable parent span ({@link ChildDatesByDayCount}). */
  childDatesById: Map<string, ChildDatesByDayCount>;
  groupName?: string;
  groupDescription?: string;
  groupImage?: ItemImageProjection;
  /** The header entity whose image gallery the public page renders (the group
   * on a group page, or the sole listing on a single-listing page); null for a
   * multi-listing combo. Just the reference — the images are read lazily on the
   * render path only ({@link renderCtx}), so submit/quote/API flows pay no read. */
  galleryTarget: { type: ImageUseItemType; id: number } | null;
  /** The header entity's images, rendered as the shared CSS gallery above the
   * form. Populated only when the page is actually rendered (renderCtx); it
   * stays `[]` on the submit/quote/API paths that never show the gallery. */
  galleryImages: readonly Image[];
  /** The package bundles sold on this page, in page order — each carrying its
   * own member ids, per-package quantities, price overrides, and hide flag. A
   * single-package page is an array of one; a plain listing page is empty. */
  packages: PagePackage[];
  /** Every CAPPED group the packages' members OR their required children belong
   * to → its remaining spots, and each of those listings → its group ids. One
   * package consumes the SUM of its members' fixed quantities (plus one child
   * unit per booked parent unit) from each such group, so a package's count is
   * bounded by `floor(remaining / demand)` per group — the package's own group
   * AND any other capped pool members or children share. Empty for pages with
   * no packages or when nothing is capped. Carried on the SHARED context so the
   * page render, the submit clamp, and the API all use ONE ceiling
   * ({@link packageBundleLimit}). Always set by {@link getTicketContext}
   * (empty Maps for a package-less page), so callers read them without a
   * fallback. */
  packageGroupRemainingByGroupId: ReadonlyMap<number, number>;
  packageMemberGroupIds: ReadonlyMap<number, number[]>;
  actionUrl?: string;
  siteToken?: string;
  promoCodesEnabled?: boolean;
  /** Opt-in add-ons offered for the page's listings (empty when none apply). */
  addOns: AddOnOption[];
};

/** Shared rendering context for ticket pages */
export type TicketCtx = TicketSharedContext & {
  slugs: string[];
  listings: TicketListing[];
  /** Each GROUP id → its remaining spots (uncapped groups omitted), set on the
   * render path so a parent sharing a capped group with its child clamps its
   * quantity by the combined parent+child demand against the SPECIFIC shared
   * group. Omitted on submit/quote (the fold's
   * authoritative date-specific check runs there instead). */
  groupRemainingByGroupId?: ReadonlyMap<number, number>;
  /** Each listing id → the ids of the groups it belongs to, set on the render
   * path alongside groupRemainingByGroupId so the shared-group quantity clamps
   * resolve the group a parent and child actually share. Omitted on submit/quote. */
  groupIdsByListingId?: ReadonlyMap<number, number[]>;
  baseUrl?: string;
  prefill?: BookingPrefill | undefined;
};

/** Possibly-async response handler */
export type AsyncHandler<T extends unknown[]> = (
  ...args: T
) => Response | Promise<Response>;

/** Shared context provider for ticket pages */
export type TicketContextProvider = (
  listings: TicketListing[],
) => Promise<TicketSharedContext>;

/** Listing with selected quantity */
export type ListingQty = { listing: ListingWithCount; qty: number };

/** Registration closed message for form submissions */
export const REGISTRATION_CLOSED_SUBMIT_MESSAGE =
  "Sorry, registration closed while you were submitting.";

/** Parse slugs from a slug string (may contain + separator for multiple listings) */
export const parseSlugs = (slug: string): string[] =>
  slug.split("+").filter((s) => s.length > 0);

/** Set noindex signal header on response; middleware converts it to X-Robots-Tag. */
export const applyNoindex = (response: Response): Response => {
  response.headers.set("x-robots-noindex", "true");
  return response;
};

/** Set noindex signal header on response for hidden listings */
export const applyHiddenNoindex = (
  response: Response,
  hidden: boolean,
): Response => (hidden ? applyNoindex(response) : response);
