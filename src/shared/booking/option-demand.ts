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
  childCanBeBooked,
  childDateOk,
  childSupportsDays,
  pageDayCounts,
  parentResolvedDuration,
  type TicketListing,
} from "#booking/model.ts";
import { childKindOf, SPAN_RULES } from "#booking/span-rules.ts";
import type { Holiday } from "#db/holidays.ts";
import { requiredMapValue } from "#fp";
import { isBookingRangeValid } from "#shared/dates.ts";
import { FormParams } from "#shared/form-data.ts";
/* jscpd:ignore-end */

/** Why the form refuses to book an option. The order is the declared
 * precedence: a structural refusal outranks a span refusal, which outranks a
 * date refusal. */
export const OptionRefusalSchema = v.picklist([
  "capacity",
  "closed",
  "date_unsupported",
  "no_bookable_child",
  "sold_out",
  "span_unsupported",
]);
export type OptionRefusal = v.InferOutput<typeof OptionRefusalSchema>;

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
 * ones. */
export type OptionDemandQuestion = {
  childrenByParentId: ChildrenByParent;
  date: string | null;
  holidays: Holiday[];
  isPackage: boolean;
  parents: readonly TicketListing[];
  quantities: ReadonlyMap<number, number>;
};

/** Why one child cannot serve one span. */
type ChildFailure = "date" | "span" | "structural";

/** Why one parent cannot fold at one span. `parent_date` is the parent's own
 * range refusing the span at the chosen date. */
type SpanFailure = ChildFailure | "capacity" | "parent_date";

/** The fold accumulator `foldChild` writes into, shaped exactly as the
 * form's own walk shapes it. */
const emptyFoldState = () => ({
  allocations: [],
  customisableDuration: null as number | null,
  customPrices: new Map<number, number>(),
  listings: [] as TicketListing[],
  quantities: new Map<number, number>(),
});

/** What one child must serve: the span, the chosen date, and the holidays. */
type Serving = {
  child: TicketListing;
  date: string | null;
  durationDays: number;
  holidays: Holiday[];
};

/** Why one child cannot serve one span, or null when it can. */
const whyChildFails = (serving: Serving): ChildFailure | null => {
  if (!childCanBeBooked(serving.child)) return "structural";
  if (!childSupportsDays(serving.child, serving.durationDays)) return "span";
  if (
    serving.date !== null &&
    !childDateOk(
      serving.date,
      serving.holidays,
      serving.durationDays,
    )(serving.child)
  ) {
    return "date";
  }
  return null;
};

/** Why no child of a parent can serve one span. The first declared failure
 * wins: a dead child outranks a span no child serves, which outranks a date
 * no child can start. */
const whyNoChildServes = (
  children: readonly TicketListing[],
  date: string | null,
  durationDays: number,
  holidays: Holiday[],
): ChildFailure => {
  const failures = children.map((child) =>
    whyChildFails({ child, date, durationDays, holidays }),
  );
  if (failures.every((failure) => failure === "structural")) {
    return "structural";
  }
  if (failures.includes("date")) return "date";
  return "span";
};

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
  parentQty: number,
  durationDays: number,
  date: string | null,
  holidays: Holiday[],
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
  const candidates = children.filter(
    (child) =>
      childSelectableForSpan(child, durationDays) &&
      (date === null || childDateOk(date, holidays, durationDays)(child)),
  );
  const resolved = resolveChildSelections(
    parent,
    candidates,
    parentQty,
    new FormParams(),
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
  for (const parent of question.parents) {
    const parentQty = parentQuantityOf(question, parent);
    if (parentQty <= 0) continue;
    const durationDays = parentResolvedDuration(parent.listing, dayCount);
    const children = question.childrenByParentId.get(parent.listing.id) ?? [];
    const fold = parentFoldsAtSpan(
      state,
      parent,
      children,
      parentQty,
      durationDays,
      question.date,
      question.holidays,
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

/** The option's refusal, carrying the parents' own pool spans. */
const refusedVerdict = (
  question: OptionDemandQuestion,
  reason: OptionRefusal,
): OptionVerdict => ({
  outcome: { reason, state: "refused" },
  spanDaysByListingId: parentSpans(question),
});

/** Every option parent's own pool span (no child is charged in a refusal). */
const parentSpans = (question: OptionDemandQuestion): Map<number, number> =>
  new Map(
    question.parents.map((parent): [number, number] => [
      parent.listing.id,
      SPAN_RULES[childKindOf(parent.listing)].directSpanDays(parent.listing),
    ]),
  );

/** The declared refusal for a set of span failures. */
const reasonOfFailures = (failures: readonly SpanFailure[]): OptionRefusal => {
  if (failures.includes("structural")) return "no_bookable_child";
  if (failures.includes("span")) return "span_unsupported";
  if (failures.includes("date") || failures.includes("parent_date")) {
    return "date_unsupported";
  }
  return "capacity";
};

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

/** Why the form's page rules offer no day count: the required children prune
 * every span, or no count is priced at all. */
const noSpanReason = (question: OptionDemandQuestion): OptionRefusal => {
  const children = [...question.childrenByParentId.values()].flat();
  const allDead =
    children.length > 0 && children.every((child) => !childCanBeBooked(child));
  return allDead ? "no_bookable_child" : "span_unsupported";
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
    spans.set(
      parent.listing.id,
      parentResolvedDuration(parent.listing, bookable.dayCount),
    );
    units.set(
      parent.listing.id,
      Math.max(units.get(parent.listing.id) ?? 0, qty),
    );
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
): Alternative =>
  alternatives.reduce((left, right) =>
    right.dayCount > left.dayCount ? right : left,
  );

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
    return refusedVerdict(question, noSpanReason(question));
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
