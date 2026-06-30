/**
 * Shared types, constants, and tiny utilities for public ticket routes
 */

import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type {
  QuestionListingMap,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import type { ListingWithCount } from "#shared/types.ts";
import type {
  BookingPrefill,
  ChildSpanDates,
  TicketListing,
} from "#templates/public.tsx";

/** Parent listing id → its bookable-child candidates, each hydrated to a
 * {@link TicketListing} so availability (isSoldOut/isClosed/maxPurchasable) is
 * resolved for the gate/render. Empty when the parents flag is off or the page
 * has no parents; children are never added to `ctx.listings` (they are not URL
 * slugs). See parents.md "Public: the booking-page gate". */
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
   * carries each parent's own dates (Fix 4); emitted as `data-child-dates` for
   * the client compatibility script (Codex 430); empty map when the page has no
   * daily children. Per selectable parent span ({@link ChildSpanDates}, Fix 4). */
  childDatesById: Map<string, ChildSpanDates>;
  groupName?: string;
  groupDescription?: string;
  /** Set when the booking page is a package group: the group's id (for signed
   * metadata) and listing-id → override price map (only members with a non-zero
   * `package_price`). `null`/absent for non-package pages. */
  packageGroupId?: number | null;
  packagePrices?: ReadonlyMap<number, number> | null;
  /** Set on a package page: listing-id → how many of that listing one package
   * unit includes (every member, default 1). The buyer chooses a single package
   * quantity and each member's booked quantity is `fixedQty × packageQty`.
   * `null`/absent for non-package pages. */
  packageQuantities?: ReadonlyMap<number, number> | null;
  /** Set on a package page: whether the member listings are hidden from buyers,
   * tickets, and confirmation emails. */
  hidePackageListings?: boolean;
  /** Set on a package page: every CAPPED group the members belong to → its
   * remaining spots, and each member → its group ids. One package consumes the
   * SUM of its members' fixed quantities from each such group, so the package
   * count is bounded by `floor(remaining / demand)` per group — the package's own
   * group AND any other capped group members happen to share (many-to-many
   * membership). Empty for non-package pages or when no member's group is capped.
   * Carried on the SHARED context so the render page and the submit clamp use the
   * same ceiling. */
  packageGroupRemainingByGroupId?: ReadonlyMap<number, number>;
  packageMemberGroupIds?: ReadonlyMap<number, number[]>;
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
   * quantity by the combined parent+child demand against the SPECIFIC shared group
   * (invariant I7, Fix 3, Codex #3). Omitted on submit/quote (the fold's
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
