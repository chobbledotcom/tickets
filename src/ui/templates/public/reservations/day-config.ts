/** Day-count selection config and child-question splitting for the booking form.
 * `dayConfig` derives the shared "number of days" selector (and per-option
 * pricing on a single-listing page) from the page's listings; `splitChildQuestions`
 * splits the page's questions into the page-level set (rendered required) and the
 * per-parent child render context (child-only questions rendered non-required). */

/* jscpd:ignore-start */
import {
  type ChildDatesByDayCount,
  pageDayCounts,
  type TicketListing,
} from "#booking/model.ts";
import { packageBundleTotal } from "#booking/price-tree.ts";
import type { BookingTree } from "#booking/tree.ts";
import type { ListingAttributesById } from "#db/attributes.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import type { QuestionListingMap } from "#db/questions/queries.ts";
import { dayPriceFor, type ListingWithCount } from "#types";
import { foldReserveByChildId } from "./child-pricing.ts";
import type { ChildRenderCtx } from "./types.ts";

/* jscpd:ignore-end */

/** On a customisable PACKAGE page, one whole bundle's price for a given day
 * count: each member node's effective per-unit price for that span (its flat
 * package override, else its per-day package override, else its own entered day
 * price — never base × days) plus its minimum unavoidable child charge, times
 * its fixed per-package quantity. Walks the canonical tree so the selector's
 * labels can't drift from what the checkout charges. `customPrices` is empty:
 * pay-more listings can't join a package. */
const packageDayCountPriceFor =
  (tree: BookingTree, bookableChildren: ReadonlySet<number>) =>
  (days: number): number =>
    packageBundleTotal(tree, days, bookableChildren);

/** The day-count option pricer for a page: a page that IS one customisable
 * package prices each option as the whole bundle's total; every other page
 * keeps the pricer {@link dayConfig} resolved (the single listing's own day
 * prices, or none). */
export const resolveDayCountPriceFor = (
  singlePackagePage: boolean,
  tree: BookingTree,
  bookableChildren: ReadonlySet<number>,
  dayCfg: {
    hasCustomisable: boolean;
    dayCountPriceFor?: ((days: number) => number | null) | undefined;
  },
): ((days: number) => number | null) | undefined =>
  singlePackagePage && dayCfg.hasCustomisable
    ? packageDayCountPriceFor(tree, bookableChildren)
    : dayCfg.dayCountPriceFor;

/**
 * Day-selection config for the booking form, derived from the page's listings.
 * Customisable-days listings drive a shared "number of days" selector; on a
 * single-listing page each option carries its price, and the date selector's
 * duration label is suppressed (the span is chosen, not fixed).
 */
export const dayConfig = (
  listings: TicketListing[],
  singleListing: ListingWithCount | null,
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  hasPackages: boolean,
): {
  hasCustomisable: boolean;
  dayCounts: number[];
  dayCountPriceFor?: ((days: number) => number | null) | undefined;
  dateDurationDays: number;
} => ({
  dateDurationDays:
    singleListing && !singleListing.customisable_days
      ? singleListing.duration_days
      : 1,
  dayCountPriceFor: singleListing?.customisable_days
    ? (days: number) => dayPriceFor(singleListing, days)
    : undefined,
  dayCounts: pageDayCounts(listings, childrenByParentId, hasPackages),
  hasCustomisable: listings.some((e) => e.listing.customisable_days),
});

/**
 * Split the page's questions into the page-level set (rendered required in the main
 * block) and the per-parent child render context (child-only questions rendered
 * non-required under their parent). A question shared by a page listing and a child
 * renders at page level once, so the child ctx's `rendered` set is pre-seeded with
 * the page question ids. Without parents the page set is unchanged and there is no
 * child ctx.
 */
export const splitChildQuestions = (
  listings: TicketListing[],
  questions: QuestionWithAnswers[],
  questionListingMap: QuestionListingMap | undefined,
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
  attributesByListing: ListingAttributesById,
): { pageQuestions: QuestionWithAnswers[]; childCtx?: ChildRenderCtx } => {
  if (!childrenByParentId || childrenByParentId.size === 0) {
    return { pageQuestions: questions };
  }
  const pageListingIds = new Set(listings.map((e) => e.listing.id));
  const isPageQuestion = (q: QuestionWithAnswers): boolean => {
    const ids = questionListingMap?.get(q.id);
    return !ids || ids.some((id) => pageListingIds.has(id));
  };
  const pageQuestions = questions.filter(isPageQuestion);
  return {
    childCtx: {
      attributesByListing,
      childDatesById,
      children: childrenByParentId,
      foldReserveByChildId: foldReserveByChildId(listings, childrenByParentId),
      groupIdsByListingId,
      groupRemainingByGroupId,
      questionListingMap,
      questions,
      rendered: new Set<number>(pageQuestions.map((q) => q.id)),
    },
    pageQuestions,
  };
};
