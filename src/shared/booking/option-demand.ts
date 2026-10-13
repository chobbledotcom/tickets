/**
 * The one place that answers, per bookable option, what the booking form
 * books and what child demand it folds, over which days. The form's fold,
 * the gallery and the checkout availability path all read this verdict, so
 * their answers cannot drift.
 *
 * The rules are the form's own. Spans and dates come from the declared
 * table (`span-rules.ts`). The child filter and the sole-child auto-fill
 * come from the fold's exported walk pieces. Nothing re-derives a rule.
 * Pure: callers hand in the resolved listings, holidays, and date.
 */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import {
  childSelectableForSpan,
  foldChild,
  resolveChildSelections,
} from "#booking/fold-tree.ts";
import {
  type ChildrenByParent,
  childDateOk,
  pageDayCounts,
  parentResolvedDuration,
  type TicketListing,
} from "#booking/model.ts";
/* jscpd:ignore-end */
import {
  noSpanReason,
  type OptionRefusal,
  OptionRefusalSchema,
  reasonOfFailures,
  type SpanFailure,
  whyNoChildServes,
} from "#booking/option-refusal.ts";
import type { Holiday } from "#db/holidays.ts";
import { requiredMapValue } from "#fp";
import { isBookingRangeValid } from "#shared/dates.ts";
import { FormParams } from "#shared/form-data.ts";

/** The units one booking takes per listing, as the schema sees it. */
const UnitsMapSchema = v.map(v.number(), v.number());

export const OptionVerdictSchema = v.object({
  outcome: v.variant("state", [
    v.object({
      /** One demand per span the form can book: the units one booking at
       * that span takes, and the days each charged listing occupies. The
       * buyer's realisable choices. Capacity is judged per alternative. */
      alternatives: v.array(
        v.object({
          dayCount: v.number(),
          spanDaysByListingId: UnitsMapSchema,
          unitsByListingId: UnitsMapSchema,
        }),
      ),
      /** The day counts the form can book the option for. */
      bookableDayCounts: v.array(v.number()),
      state: v.literal("bookable"),
    }),
    v.object({ reason: OptionRefusalSchema, state: v.literal("refused") }),
  ]),
  /** The days each charged listing's booking occupies from the start date:
   * the widest alternative's spans, and the parents' own spans in a
   * refusal. Pools are sized over these. Judging reads the alternatives. */
  spanDaysByListingId: UnitsMapSchema,
});
export type OptionVerdict = v.InferOutput<typeof OptionVerdictSchema>;

/** One option's booking question: the parents one selection books, the
 * required children, and the units per parent. The date is null in the
 * form's render phase, before a date is chosen. Holidays are the active
 * ones. `choices` carries the buyer's explicit child selections when the
 * submitted form names them. Without it the judge judges the form's own
 * empty-form fold (auto-select or buyer-must-choose). */
export type OptionDemandQuestion = {
  childrenByParentId: ChildrenByParent;
  choices?: FormParams | undefined;
  date: string | null;
  holidays: Holiday[];
  isPackage: boolean;
  parents: readonly TicketListing[];
  quantities: ReadonlyMap<number, number>;
};

/** The fold accumulator `foldChild` writes into, shaped exactly as the
 * form's own walk shapes it. */
const emptyFoldState = () => ({
  allocations: [],
  customisableDuration: null as number | null,
  customPrices: new Map<number, number>(),
  listings: [] as TicketListing[],
  quantities: new Map<number, number>(),
});

/** The units one fold books and the span each charged child occupies. */
type FoldedDemand = {
  spans: Map<number, number>;
  units: Map<number, number>;
};

/** One fold attempt at one span, or why the span fails. A parent's fold and
 * a whole option's fold share the shape, so the option fold sums the parent
 * folds. */
type SpanFold =
  | ({ ok: true } & FoldedDemand)
  | { failure: SpanFailure; ok: false };

/** A span the form can book where no child quantity is guaranteed yet. */
const NOTHING_FOLDED: SpanFold = {
  ok: true,
  spans: new Map(),
  units: new Map(),
};

/** Fresh accumulators for one fold attempt. */
const newFoldAccumulators = (): FoldedDemand => ({
  spans: new Map(),
  units: new Map(),
});

/** Fold an incoming units map into an accumulator, combining each listing's
 * figures: the form sums a child's lines, and the charged spans widen. */
const mergeUnits = (
  units: Map<number, number>,
  incoming: ReadonlyMap<number, number>,
  combine: (accumulated: number, incoming: number) => number,
): void => {
  for (const [listingId, qty] of incoming) {
    units.set(listingId, combine(units.get(listingId) ?? 0, qty));
  }
};

const parentFoldsAtSpan = (
  state: ReturnType<typeof emptyFoldState>,
  parent: TicketListing,
  children: readonly TicketListing[],
  candidates: readonly TicketListing[],
  parentQty: number,
  durationDays: number,
  date: string | null,
  holidays: Holiday[],
  choices: FormParams,
): SpanFold => {
  // The parent's own booking must hold the span at the chosen date, exactly
  // as the form's submit validates the day count.
  if (
    date !== null &&
    parent.listing.listing_type === "daily" &&
    !isBookingRangeValid(parent.listing, date, durationDays, holidays)
  ) {
    return { failure: "parent_date", ok: false };
  }
  // A parent without children folds trivially: the form's walk never
  // reaches the child resolver for it.
  if (children.length === 0) return NOTHING_FOLDED;
  const resolved = resolveChildSelections(
    parent,
    candidates,
    parentQty,
    choices,
  );
  if ("error" in resolved) {
    // An empty form submits no child choice. "Too few" then means several
    // children can serve the span, and the buyer must pick one — the form
    // can still book it. Only an empty bookable set refuses.
    if (candidates.length > 0) return NOTHING_FOLDED;
    return {
      failure: whyNoChildServes(children, date, durationDays, holidays),
      ok: false,
    };
  }
  const { spans, units } = newFoldAccumulators();
  for (const { child, qty } of resolved) {
    const error = foldChild(
      state,
      child,
      qty,
      durationDays,
      parent.listing.id,
      undefined,
    );
    if (error !== null) return { failure: "capacity", ok: false };
    units.set(child.listing.id, (units.get(child.listing.id) ?? 0) + qty);
    spans.set(child.listing.id, durationDays);
  }
  return { ok: true, spans, units };
};

/** The units one parent books in the option, or 0 when it books none. */
const parentQuantityOf = (
  question: OptionDemandQuestion,
  parent: TicketListing,
): number =>
  requiredMapValue(
    question.quantities,
    parent.listing.id,
    `Option quantities miss parent ${parent.listing.id}`,
  );

/** One member's fold inputs at one span. Its candidates are the children the
 * form can book at that span and date. The feasibility pre-pass and the fold
 * read these beside the member's children, quantity, and resolved duration. */
type SpanMember = {
  candidates: TicketListing[];
  children: TicketListing[];
  durationDays: number;
  parent: TicketListing;
  parentQty: number;
};

const memberAtSpan = (
  question: OptionDemandQuestion,
  parent: TicketListing,
  dayCount: number,
): SpanMember => {
  const durationDays = parentResolvedDuration(parent.listing, dayCount);
  const children = [
    ...(question.childrenByParentId.get(parent.listing.id) ?? []),
  ];
  const candidates = children.filter(
    (child) =>
      childSelectableForSpan(child, durationDays) &&
      (question.date === null ||
        childDateOk(question.date, question.holidays, durationDays)(child)),
  );
  return {
    candidates,
    children,
    durationDays,
    parent,
    parentQty: parentQuantityOf(question, parent),
  };
};

/** The durations the members' selections record at this span, before any
 * fold runs. A parent whose every candidate is customisable records its
 * resolved duration whichever child the buyer picks. Two members demanding
 * different durations then refuse whatever order the walk visits them in.
 * A parent with a non-customisable candidate lets the buyer dodge the
 * duration, so it adds none. */
const requiredDurations = (
  seededDuration: number | null,
  members: readonly SpanMember[],
): Set<number> => {
  const required = new Set<number>();
  for (const { durationDays, candidates } of members) {
    if (candidates.length === 0) continue;
    if (candidates.some((child) => !child.listing.customisable_days)) continue;
    if (seededDuration !== null) required.add(seededDuration);
    required.add(durationDays);
  }
  return required;
};

/** One candidate span judged over every parent through the ONE order-wide
 * fold state the form walks with. The customisable duration records once,
 * so two members inheriting different durations refuse here as the form
 * refuses. Returns the child units the form folds, summed across parents,
 * or the first failure. */
const spanOutcome = (
  question: OptionDemandQuestion,
  dayCount: number,
): SpanFold => {
  const state = emptyFoldState();
  // The form seeds the fold's customisable duration with the buyer's chosen
  // span when the option carries a customisable parent.
  if (question.parents.some((parent) => parent.listing.customisable_days)) {
    state.customisableDuration = dayCount;
  }
  const { spans, units } = newFoldAccumulators();
  // Each member's candidates at this span, computed once: the feasibility
  // pre-pass and the fold must read the same sets.
  const members = question.parents.map((parent) =>
    memberAtSpan(question, parent, dayCount),
  );
  if (requiredDurations(state.customisableDuration, members).size > 1) {
    return { failure: "capacity", ok: false };
  }
  for (const {
    parent,
    parentQty,
    durationDays,
    children,
    candidates,
  } of members) {
    const fold = parentFoldsAtSpan(
      state,
      parent,
      children,
      candidates,
      parentQty,
      durationDays,
      question.date,
      question.holidays,
      question.choices ?? new FormParams(),
    );
    if (!fold.ok) return fold;
    mergeUnits(
      units,
      fold.units,
      (accumulated, incoming) => accumulated + incoming,
    );
    mergeUnits(spans, fold.spans, Math.max);
  }
  return { ok: true, spans, units };
};

/** The option's refusal. No demand folds in a refusal, so no span map
 * rides along: the option's pool span stays whatever the card declared. */
const refusedVerdict = (
  _question: OptionDemandQuestion,
  reason: OptionRefusal,
): OptionVerdict => ({
  outcome: { reason, state: "refused" },
  spanDaysByListingId: new Map(),
});

/** The option-level gate refusals, or null when no parent is gated. */
const gateRefusal = (question: OptionDemandQuestion): OptionRefusal | null => {
  for (const parent of question.parents) {
    if (parent.isClosed) return "closed";
    if (parent.isSoldOut) return "sold_out";
  }
  return null;
};

/** The day counts the form's own page rules offer for the option. They are
 * the priced counts its customisable parents share, or one fixed span for
 * anything else. */
const offeredSpans = (question: OptionDemandQuestion): number[] => {
  const hasCustomisable = question.parents.some(
    (parent) => parent.listing.customisable_days,
  );
  if (!hasCustomisable) return [1];
  return pageDayCounts(
    [...question.parents],
    question.childrenByParentId,
    question.isPackage,
  );
};

/** One judged span the form can book. */
type BookableSpan = {
  dayCount: number;
  spans: ReadonlyMap<number, number>;
  units: ReadonlyMap<number, number>;
};

/** One span's realisable booking: the units one booking at that span takes,
 * and the days each charged listing occupies. */
export type Alternative = {
  dayCount: number;
  spanDaysByListingId: Map<number, number>;
  unitsByListingId: Map<number, number>;
};

/** One span's realisable booking: the fold's child demand plus the parents'
 * own demand at the span they actually book. The parents' pool span is the
 * span the form books them for, never the one-day preview default. */
const alternativeOf = (
  question: OptionDemandQuestion,
  bookable: BookableSpan,
): Alternative => {
  const spans = new Map(bookable.spans);
  const units = new Map(bookable.units);
  for (const parent of question.parents) {
    const qty = parentQuantityOf(question, parent);
    if (qty <= 0) continue;
    const span = parentResolvedDuration(parent.listing, bookable.dayCount);
    spans.set(parent.listing.id, span);
    const charged = Math.max(units.get(parent.listing.id) ?? 0, qty);
    units.set(parent.listing.id, charged);
  }
  return {
    dayCount: bookable.dayCount,
    spanDaysByListingId: spans,
    unitsByListingId: units,
  };
};

/** The widest alternative: the biggest span the buyer can pick, whose
 * demand is the option's committed preview. */
export const widestAlternative = (
  alternatives: readonly Alternative[],
): Alternative => {
  let widest = alternatives[0]!;
  for (const alternative of alternatives) {
    if (alternative.dayCount > widest.dayCount) widest = alternative;
  }
  return widest;
};

/** Judge one option the way the booking form books it. It judges every span
 * the form's own page rules offer, at the chosen date, or date-less in the
 * render phase. The option is bookable when the form can book at least one
 * span, and each bookable span carries its own realisable demand. The
 * committed preview is the widest alternative: the biggest span the buyer
 * can pick. */
export const judgeOptionDemand = (
  question: OptionDemandQuestion,
): OptionVerdict => {
  const gated = gateRefusal(question);
  if (gated !== null) return refusedVerdict(question, gated);
  const candidates = offeredSpans(question);
  if (candidates.length === 0) {
    return refusedVerdict(
      question,
      noSpanReason([...question.childrenByParentId.values()].flat()),
    );
  }
  const judged = candidates.map((dayCount) => ({
    dayCount,
    outcome: spanOutcome(question, dayCount),
  }));
  const failures = judged.flatMap(({ outcome }) =>
    outcome.ok ? [] : [outcome.failure],
  );
  const alternatives = judged.flatMap(({ dayCount, outcome }): Alternative[] =>
    outcome.ok
      ? [
          alternativeOf(question, {
            dayCount,
            spans: outcome.spans,
            units: outcome.units,
          }),
        ]
      : [],
  );
  if (alternatives.length === 0) {
    return refusedVerdict(question, reasonOfFailures(failures));
  }
  const widest = widestAlternative(alternatives);
  return {
    outcome: {
      alternatives,
      bookableDayCounts: alternatives.map(({ dayCount }) => dayCount),
      state: "bookable",
    },
    spanDaysByListingId: widest.spanDaysByListingId,
  };
};
