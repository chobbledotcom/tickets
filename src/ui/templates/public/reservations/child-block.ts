import { t } from "#i18n";
import {
  type ChildDatesByDayCount,
  childDateKey,
  dayCountsChildSupports,
  encodeChildDatesByDayCount,
  type TicketListing,
} from "#shared/booking/model.ts";
import {
  childCanBeBooked,
  childTicketLimit,
  groupCapacityInfo,
  packageChildTicketLimits,
  packageLimitInfo,
} from "#shared/booking/package-cap.ts";
import {
  childPriceFieldName,
  childQuantityFieldName,
} from "#shared/booking/tree.ts";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import type { QuestionListingMap } from "#shared/db/questions/queries.ts";
import { savedFormValue } from "#shared/forms.tsx";
import type { ListingWithCount } from "#shared/types.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { renderListingAttributes } from "../listing-attributes.ts";
import { childPriceLabel, childPriceMinor } from "./child-price.ts";
import {
  clampSavedQuantity,
  quantityOptions,
  renderPayMoreInput,
} from "./inputs.ts";
import { answerableQuestion, renderQuestion } from "./questions.tsx";

/**
 * Per-parent child rendering inputs threaded down to the listing rows: the page's
 * children grouped by parent, the page questions and their listing map (to render
 * each child's questions), and a shared `rendered` set so a question shared by
 * sibling children (or by the parent) renders exactly once. Empty
 * `children` means the page has no parents and nothing extra renders.
 */
export type ChildRenderCtx = {
  children: Map<number, TicketListing[]>;
  /** Daily-child start dates for each parent day count. */
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>;
  /** Remaining spots for limited groups. */
  groupRemainingByGroupId: ReadonlyMap<number, number>;
  /** Groups each listing belongs to. */
  groupIdsByListingId: ReadonlyMap<number, number[]>;
  questions: QuestionWithAnswers[];
  questionListingMap: QuestionListingMap | undefined;
  rendered: Set<number>;
  /** Child tickets already promised to parents on this page. */
  foldReserveByChildId: ReadonlyMap<number, number>;
  /** Selected listing attributes, for rendering on child options. */
  attributesByListing: ListingAttributesById;
};

/** Max parent tickets after checking the children it must book too. */
export const childLimitedMax = (
  info: TicketListing,
  childCtx: ChildRenderCtx | undefined,
): number => {
  if (!childCtx) return info.maxPurchasable;
  const limits = packageChildTicketLimits(
    packageLimitInfo(
      [info],
      childCtx.children,
      childCtx.groupRemainingByGroupId,
      childCtx.groupIdsByListingId,
    ),
  );
  const childLimit = limits.get(info.listing.id);
  const ownMax =
    childLimit === undefined
      ? info.maxPurchasable
      : Math.min(info.maxPurchasable, childLimit);
  // Hold back child tickets the parent selector can already spend.
  const reserved = childCtx.foldReserveByChildId.get(info.listing.id) ?? 0;
  return Math.max(0, ownMax - reserved);
};

/** The questions assigned to a child listing, in page order, that have not yet
 * been rendered on the page (deduped across siblings/parent via `rendered`). */
const childQuestionsToRender = (
  childId: number,
  ctx: ChildRenderCtx,
): QuestionWithAnswers[] =>
  ctx.questions.filter((q) => {
    if (ctx.rendered.has(q.id) || !answerableQuestion(q)) return false;
    const ids = ctx.questionListingMap?.get(q.id);
    // No listing map ⇒ applies to every selected listing (assign_all); otherwise
    // only when this child is among its listings.
    return !ids || ids.includes(childId);
  });

/** The per-unit quantity restored for a child select after a validation
 * re-render: the buyer's submitted `child_qty_<parentId>_<childId>`, clamped to
 * `0..max`, else 0. */
const restoredChildQty = (
  parentId: number,
  childId: number,
  max: number,
): number =>
  clampSavedQuantity(
    savedFormValue(childQuantityFieldName(parentId, childId)),
    max,
    0,
  );

/** A pay-more child's (non-required) price input, or "" when the child isn't
 * pay-more or (for a per-unit option) isn't bookable. Shared by the per-unit and
 * sole-child renderers so the field name + non-required flag can't drift. */
const childPriceInput = (
  parentId: number,
  listing: ListingWithCount,
  include: boolean,
): string =>
  include && listing.can_pay_more
    ? renderPayMoreInput(
        listing,
        childPriceFieldName(parentId, listing.id),
        undefined,
        false,
      )
    : "";

/** Adds the child date data the browser uses to disable impossible choices. */
const childDateAttrs = (
  parentId: number,
  child: TicketListing,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
): string => {
  const attrs: string[] = [];
  const dates = childDatesById.get(childDateKey(parentId, child.listing.id));
  if (dates !== undefined) {
    attrs.push(
      ` data-child-dates="${escapeHtml(encodeChildDatesByDayCount(dates))}"`,
    );
  }
  const dayCounts = dayCountsChildSupports(child);
  if (dayCounts !== null) {
    attrs.push(` data-child-spans="${escapeHtml(dayCounts.join(","))}"`);
  }
  return attrs.join("");
};

/** Render one child as a per-unit quantity row: a `child_qty_<parentId>_<childId>`
 * select over `0..childLimit`, plus — for a bookable pay-more child — its
 * non-required price input. A sold-out/closed/inactive child renders a disabled
 * select fixed at 0, never selectable. The select is non-required in
 * markup; the server fold validates the per-parent total. A bookable
 * child also carries its date/span compatibility attributes ({@link
 * childDateAttrs}) for the client compatibility script. */
/** Inputs shared by every child-option rendering: which parent it sits under,
 * the child itself, its date/span markers, and whether £0 prices are shown. */
type ChildOption = {
  parent: ListingWithCount;
  child: TicketListing;
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>;
  showZero: boolean;
  /** This child's selected-attributes markup, appended after its price. */
  attributesHtml: string;
};

/** The parent id and child listing every child-option renderer derives first. */
const childOptionParts = (
  opt: ChildOption,
): { parentId: number; listing: ListingWithCount } => ({
  listing: opt.child.listing,
  parentId: opt.parent.id,
});

/** Render a sole bookable child as INFORMATIONAL (auto-select preserved): no
 * submitted `child_qty_<parentId>_<childId>` field at all — the server fold
 * auto-fills the sole child to the parent's quantity Q whenever nothing was
 * submitted, so emitting a fixed quantity would over-submit and the fold would
 * reject it as "too many" when Q is below that cap. Instead show
 * just the child's name plus its (non-zero) price, and — for a pay-more sole child
 * — its (non-required) price input, which the fold reads for the auto-selected
 * child. No-JS safe: nothing posts a quantity for it.
 *
 * The buyer makes no choice for a sole child, so it carries no "choose an option"
 * prompt (that lives on the parent's `<legend>`, suppressed for a sole child — see
 * {@link renderChildBlock}). A HIDDEN child shows nothing visible — the operator
 * hid it from public view — but keeps its data markers and pay-more price input so
 * the fold and the compat/required client scripts still drive off them.
 *
 * The informational marker ALSO carries the same date/span compatibility
 * attributes a selectable child option does ({@link childDateAttrs}) so on a
 * group/multi-listing page (where the date/day-count controls aren't globally
 * constrained to the child's calendar) the client script can tell the auto-selected
 * sole child can't serve the chosen date/span and flag/disable the parent — rather
 * than letting the buyer hit the submit-side `child_sold_out` rejection. */
const renderSoleChildOption = (opt: ChildOption): string => {
  const { parentId, listing } = childOptionParts(opt);
  const priceHtml = childPriceInput(parentId, listing, true);
  const visible = !listing.hidden;
  const namePart = visible ? escapeHtml(listing.name) : "";
  const pricePart = visible
    ? childPriceLabel(listing, opt.parent, opt.showZero)
    : "";
  const label = `${namePart} ${pricePart}`.trim();
  const dateAttrs = childDateAttrs(parentId, opt.child, opt.childDatesById);
  return `<p class="child-option child-sole" data-sole-parent="${parentId}" data-sole-child="${listing.id}"${dateAttrs}>${label}</p>${priceHtml}${opt.attributesHtml}`;
};

/** Render one child as a per-unit quantity option (select over `0..childLimit`
 * plus a bookable pay-more child's price input and date/span markers), or a
 * disabled zero select for an unavailable child. A SOLE bookable child renders
 * as an informational marker instead ({@link renderSoleChildOption}). */
const renderChildOption = (opt: ChildOption, childLimit: number): string => {
  const { parentId, listing } = childOptionParts(opt);
  const bookable = childCanBeBooked(opt.child);
  const selectName = childQuantityFieldName(parentId, listing.id);
  const priceHtml = childPriceInput(parentId, listing, bookable);
  const label = bookable
    ? `${escapeHtml(listing.name)} ${childPriceLabel(
        listing,
        opt.parent,
        opt.showZero,
      )}`.trim()
    : escapeHtml(t("public.ticket.child_unavailable", { name: listing.name }));
  const select = bookable
    ? `<select name="${selectName}" data-child-qty="${listing.id}"${childDateAttrs(
        parentId,
        opt.child,
        opt.childDatesById,
      )}>${quantityOptions(
        childLimit,
        restoredChildQty(parentId, listing.id, childLimit),
      )}</select>`
    : `<select name="${selectName}" disabled><option value="0" selected>0</option></select>`;
  return `<label class="child-option">${select} ${label}</label>${priceHtml}${opt.attributesHtml}`;
};

/**
 * Render the per-parent child block: a `child_qty_<parentId>_<childId>` select per
 * child, a "Choose <Q> add-on(s) in total" note plus a live "X of Q chosen" hint,
 * each bookable pay-more child's price input, and the children's questions (deduped,
 * non-required). A SOLE bookable child renders as informational (auto-select
 * preserved, see {@link renderSoleChildOption}). Empty string when the parent has
 * no children. Requiredness/totals are enforced server-side.
 */
export const renderChildBlock = (
  parentInfo: TicketListing,
  ctx: ChildRenderCtx,
): string => {
  const parent = parentInfo.listing;
  const parentId = parent.id;
  const children = ctx.children.get(parentId);
  if (!children || children.length === 0) return "";
  const bookable = children.filter(childCanBeBooked);
  // The parent's effective max is the per-parent total ceiling; each child select is
  // additionally capped by its own parent+child order capacity (below).
  const total = childLimitedMax(parentInfo, ctx);
  // A SOLE bookable child is auto-selected by the fold (informational), so the buyer
  // makes no choice: suppress the "choose an option" legend and the "choose N in
  // total" guidance and let the child option show its name directly.
  const sole = bookable.length === 1;
  // Hide prices across the WHOLE block when every bookable child is free (£0): a
  // solo free child shows no "(£0)", and an all-free multi-child selector drops every
  // price; one paid sibling among free children keeps all prices (including the £0
  // ones) so the buyer can still compare.
  const showZero = !bookable.every(
    (child) => childPriceMinor(child.listing, parent) === 0,
  );
  const isSole = (child: TicketListing): boolean =>
    bookable.length === 1 && bookable[0]!.listing.id === child.listing.id;
  const options = children
    .map((child) => {
      const opt: ChildOption = {
        attributesHtml: renderListingAttributes(
          ctx.attributesByListing.get(child.listing.id),
        ),
        child,
        childDatesById: ctx.childDatesById,
        parent,
        showZero,
      };
      return isSole(child)
        ? renderSoleChildOption(opt)
        : renderChildOption(
            opt,
            childCanBeBooked(child)
              ? Math.min(
                  total,
                  childTicketLimit(
                    parentInfo,
                    child,
                    groupCapacityInfo(
                      ctx.groupRemainingByGroupId,
                      ctx.groupIdsByListingId,
                    ),
                  ),
                )
              : 0,
          );
    })
    .join("");
  const questionsHtml = children
    .map((child) => {
      const toRender = childQuestionsToRender(child.listing.id, ctx);
      for (const q of toRender) ctx.rendered.add(q.id);
      return toRender
        .map((q) =>
          String(
            renderQuestion(
              q,
              false,
              ctx.questionListingMap?.get(q.id)?.join(" "),
            ),
          ),
        )
        .join("");
    })
    .join("");
  // The "choose N in total" note + live hint guide the per-unit selection. At no-JS
  // render the parent quantity isn't chosen yet, so the note seeds with the parent's
  // effective max; JS recomputes it live against the parent select. Suppressed for a
  // sole auto-selected child — nothing for the buyer to choose.
  const note = sole
    ? ""
    : `<p class="child-total-note" data-child-total="${parentId}">` +
      `${escapeHtml(t("public.ticket.choose_total", { count: total }))} ` +
      `<span class="child-total-hint" data-child-hint="${parentId}"></span></p>`;
  const legend = sole
    ? ""
    : `<legend>${escapeHtml(
        t("public.ticket.choose_option", { name: parent.name }),
      )}</legend>`;
  return (
    `<fieldset class="child-selector" data-parent-id="${parentId}">` +
    `${legend}${note}${options}${questionsHtml}</fieldset>`
  );
};

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

/** For every child that a PAGE parent folds, the capacity to reserve from that
 * child's own standalone row: the sum of each such parent's own `maxPurchasable`.
 * A parent books at most that many units, each folding at most one unit of this
 * child, so holding back the sum guarantees the standalone row plus the parents'
 * folds can never exceed the child's capacity. Only parents present on the page
 * (they render a selector) reserve; a child with no page parent maps to nothing. */
const foldReserveByChildId = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]>,
): Map<number, number> => {
  const reserve = new Map<number, number>();
  for (const parent of listings) {
    const children = childrenByParentId.get(parent.listing.id);
    if (!children) continue;
    for (const child of children) {
      reserve.set(
        child.listing.id,
        (reserve.get(child.listing.id) ?? 0) + parent.maxPurchasable,
      );
    }
  }
  return reserve;
};
