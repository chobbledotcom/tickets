import { filter, mapNotNullish, pipe } from "#fp";
import { t } from "#i18n";
import {
  type BuildTreeInput,
  buildBookingTree,
} from "#shared/booking/build-tree.ts";
import {
  bookableChildIds,
  type ChildDatesByDayCount,
  childDateKey,
  childDaysFromParent,
  dayCountsChildSupports,
  dayCountsEveryListingSupports,
  encodeChildDatesByDayCount,
  keepParentDayCountsChildrenSupport,
  packageDayCountsChildrenSupport,
  type TicketListing,
} from "#shared/booking/model.ts";
import {
  childCanBeBooked,
  childTicketLimit,
  groupCapacityInfo,
  packageBundleLimit,
  packageChildTicketLimits,
  packageLimitInfo,
} from "#shared/booking/package-cap.ts";
import { packageBundleTotal } from "#shared/booking/price-tree.ts";
import {
  type BookingNode,
  type BookingTree,
  childPriceFieldName,
  childQuantityFieldName,
  nodePriceFieldName,
  nodeQuantityFieldName,
  PACKAGE_QUANTITY_FIELD,
  quantityFieldName,
} from "#shared/booking/tree.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import {
  daysAgo,
  formatDateLabel,
  formatDatetimeLabel,
} from "#shared/dates.ts";
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type {
  QuestionListingMap,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms.tsx";
import {
  CsrfForm,
  Flash,
  renderFields,
  savedFormValue,
} from "#shared/forms.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type ItemImageProjection,
  isPaidListing,
  type ListingFields,
  type ListingWithCount,
} from "#shared/types.ts";
import { Badge } from "#templates/components/badge.tsx";
import { moneyPattern } from "#templates/components/price-input.tsx";
import {
  freeTextQuestion,
  questionFieldset,
  questionWrapper,
} from "#templates/components/question-text.tsx";
import { getTicketFields, mergeListingFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import { renderListingImage } from "./shared.tsx";
/** OpenGraph meta tags for a public listing page. */
export const buildOgTags = (
  listing: {
    name: string;
    description?: string | null | undefined;
    image_alt_text?: string | undefined;
    slug: string;
    image_url: string;
  },
  baseUrl: string,
): string => {
  const tags = [
    `<meta property="og:title" content="${escapeHtml(listing.name)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtml(baseUrl)}/ticket/${escapeHtml(
      listing.slug,
    )}">`,
  ];
  if (listing.description) {
    tags.push(
      `<meta property="og:description" content="${escapeHtml(
        listing.description,
      )}">`,
    );
  }
  if (listing.image_url) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(baseUrl)}${escapeHtml(
        getImageProxyUrl(listing.image_url),
      )}">`,
    );
    if (listing.image_alt_text) {
      tags.push(
        `<meta property="og:image:alt" content="${escapeHtml(
          listing.image_alt_text,
        )}">`,
      );
    }
  }
  return tags.join("\n");
};

/** A date-selector dropdown for daily listings. */
const renderDateSelector = (
  dates: string[],
  selected = "",
  durationDays = 1,
): string =>
  dates.length === 0
    ? `<div class="error" role="alert">${t(
        "public.ticket.no_dates_available",
      )}</div>`
    : `<label for="date">${t("public.ticket.select_date")}${
        durationDays > 1
          ? ` <small>(${t("public.ticket.date_duration_hint", {
              durationDays,
            })})</small>`
          : ""
      }</label>
       <select name="date" id="date" required>
         <option value="">${t("public.ticket.select_date_placeholder")}</option>
         ${dates
           .map(
             (d) =>
               `<option value="${d}"${d === selected ? " selected" : ""}>${formatDateLabel(
                 d,
               )}</option>`,
           )
           .join("")}
       </select>`;

/** Render the "number of days" selector for customisable-days listings. When a
 * single listing drives the page, each option shows its price for that span.
 * The submitted day count is restored when a validation error re-renders. */
const renderDayCountSelector = (
  counts: number[],
  priceFor?: (days: number) => number | null,
): string => {
  if (counts.length === 0) {
    return `<div class="error" role="alert">${t(
      "public.ticket.no_booking_lengths",
    )}</div>`;
  }
  const selected = savedFormValue("day_count");
  return `<label for="day_count">${t("public.ticket.number_of_days")}</label>
       <select name="day_count" id="day_count" required>
         <option value="">${t("public.ticket.select_placeholder")}</option>
         ${counts
           .map((n) => {
             const price = priceFor?.(n);
             const suffix =
               price !== undefined && price !== null
                 ? ` — ${formatCurrency(price)}`
                 : "";
             return `<option value="${n}"${
               selected === String(n) ? " selected" : ""
             }>${t("public.ticket.day_option", { count: n })}${suffix}</option>`;
           })
           .join("")}
       </select>`;
};

/** Quantity values parsed from ticket form */
export type TicketQuantities = Map<number, number>;

/** A price input for pay-more listings. `required` is the HTML constraint: page
 * listings emit a required input when the minimum price is above zero, but a
 * child's pay-more input renders non-required — the no-JS baseline emits one for
 * every pay-more child of a parent, so a `required` input would block submit
 * demanding a price for an UNSELECTED child; the server validates only the chosen
 * child's price. */
const renderPayMoreInput = (
  listing: Pick<ListingWithCount, "unit_price" | "max_price">,
  fieldName = "custom_price",
  prefillMinor?: number,
  required = true,
): string => {
  const minPrice = listing.unit_price;
  const maxPrice = listing.max_price;
  const rangeHint =
    minPrice > 0
      ? t("public.ticket.your_price_min", { min: formatCurrency(minPrice) })
      : t("public.ticket.your_price_optional", {
          max: formatCurrency(maxPrice),
        });
  const prefillValue =
    prefillMinor !== undefined && prefillMinor >= minPrice
      ? prefillMinor
      : minPrice;
  // Restore what was typed on a validation re-render (already in major units),
  // else fall back to the pre-fill/minimum.
  const saved = savedFormValue(fieldName);
  const value = saved !== "" ? saved : toMajorUnits(prefillValue);
  return (
    `<label>${rangeHint}` +
    `<input type="text" inputmode="decimal" name="${fieldName}" value="${escapeHtml(
      value,
    )}" min="${escapeHtml(toMajorUnits(minPrice))}" max="${escapeHtml(
      toMajorUnits(maxPrice),
    )}" pattern="${moneyPattern()}" title="${escapeHtml(
      t("public.ticket.price_input_title"),
    )}"${required && minPrice > 0 ? " required" : ""} /></label>`
  );
};

/** Render terms and conditions block with agreement checkbox. The checkbox stays
 * ticked when a validation error re-renders so agreement isn't lost. */
const renderTermsAndCheckbox = (terms: string): string => {
  const checked = savedFormValue("agree_terms") === "1" ? " checked" : "";
  return (
    `<div class="prose">${renderMarkdown(terms)}</div>` +
    `<label class="terms-agree"><input type="checkbox" name="agree_terms" value="1"${checked} required> ${t(
      "public.ticket.agree_terms",
    )}</label>`
  );
};

/** Render one question control. `required` is the HTML constraint: page listings
 * emit required controls; folded child questions render non-required (the server
 * enforces requiredness only for the selected child). `listingIds`
 * (when present) lets the visibility script show/hide.
 *
 * Question text may contain markdown. When the markdown is simple (plain text in
 * a single paragraph) it is embedded directly inside the `<label>`/`<legend>` so
 * the label-click-focuses-control feature works. When complex it is rendered as
 * a `<div class="prose">` before the control, and the wrapping element becomes a
 * `<div>` (or the legend is dropped) so the long prose isn't trapped inside a
 * label. */
const renderQuestion = (
  q: QuestionWithAnswers,
  required: boolean,
  listingIds?: string,
): JSX.Element => {
  const answered = savedFormValue(`question_${q.id}`);
  const options = q.answers.filter((a) => a.active);
  if (q.display_type === "free_text") {
    return freeTextQuestion({ listingIds, q, required, value: answered });
  }
  if (q.display_type === "select") {
    return questionWrapper(q, listingIds, (labelledBy) => (
      <select
        aria-labelledby={labelledBy}
        name={`question_${q.id}`}
        required={required}
      >
        <option value="">{t("public.ticket.select_answer_placeholder")}</option>
        {options.map((a) => (
          <option selected={answered === String(a.id)} value={String(a.id)}>
            {a.text}
          </option>
        ))}
      </select>
    ));
  }
  return questionFieldset(
    q,
    listingIds,
    options.map((a) => (
      <label>
        <input
          checked={answered === String(a.id)}
          name={`question_${q.id}`}
          required={required}
          type="radio"
          value={String(a.id)}
        />{" "}
        {a.text}
      </label>
    )),
  );
};

/** A choice question whose answers are all deactivated has nothing selectable, so
 * drop it rather than render a required control a buyer can't satisfy (the parser
 * likewise treats it as not applicable). */
const answerableQuestion = (q: QuestionWithAnswers): boolean =>
  q.display_type === "free_text" || q.answers.some((a) => a.active);

/** Render the custom question fields. A `questionListingMap` adds data-listing-ids
 * so JS can show/hide questions based on selected listing quantities. */
export const renderQuestions = (
  questions: QuestionWithAnswers[],
  questionListingMap?: QuestionListingMap,
): JSX.Element => (
  <>
    {questions
      .filter(answerableQuestion)
      .map((q) =>
        renderQuestion(q, true, questionListingMap?.get(q.id)?.join(" ")),
      )}
  </>
);

/** Description HTML for a listing row. */
const renderListingDescription = (description: string): string =>
  description
    ? `<div class="description-compact">${renderMarkdown(description)}</div>`
    : "";

/** Per-listing pre-fill applied when scanning a signed QR link */
export type TicketPrefill = {
  quantity?: number;
  /** Pre-fill the custom_price input for can_pay_more listings (minor units) */
  customPriceMinor?: number;
};

/** An `<option>` list `0..max` for a quantity selector, with `selected` chosen. */
const quantityOptions = (max: number, selected: number): string =>
  Array.from({ length: max + 1 }, (_, i) => i)
    .map(
      (n) =>
        `<option value="${n}"${
          n === selected ? " selected" : ""
        }>${n}</option>`,
    )
    .join("");

/** The pre-filled quantity, clamped to the allowed range. */
const resolveQuantity = (
  prefill: TicketPrefill | undefined,
  maxPurchasable: number,
): number => {
  if (!prefill?.quantity) return 0;
  return Math.max(0, Math.min(prefill.quantity, maxPurchasable));
};

/** Clamp a just-submitted numeric form value to `[0, max]`, falling back to
 * `fallback` when the field was absent (`""`). Shared by the per-listing and
 * package-count restores so the two can't drift. */
const clampSavedQuantity = (
  saved: string,
  max: number,
  fallback: number,
): number =>
  saved === ""
    ? fallback
    : Math.max(0, Math.min(Number.parseInt(saved, 10) || 0, max));

/** The quantity to pre-select for a row: the value the visitor just submitted
 * (restored when a validation error re-renders the page), else the QR/order
 * pre-fill — both clamped to the available range. */
const restoredQuantity = (
  listingId: number,
  prefill: TicketPrefill | undefined,
  maxPurchasable: number,
): number =>
  clampSavedQuantity(
    savedFormValue(quantityFieldName(listingId)),
    maxPurchasable,
    resolveQuantity(prefill, maxPurchasable),
  );

/** The package count to pre-select: the value the buyer just submitted (restored
 * when a validation error re-renders the page) clamped to the limit, else 1 (or 0
 * when nothing can be ordered). Without this an error would silently reset a
 * multi-package order to one, risking a wrong-quantity resubmit. */
const restoredPackageQuantity = (limit: number): number =>
  clampSavedQuantity(
    savedFormValue(PACKAGE_QUANTITY_FIELD),
    limit,
    Math.min(1, limit),
  );

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
};

/** Max parent tickets after checking the children it must book too. */
const childLimitedMax = (
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

/** The duration a customisable child inherits at no-JS render, or null when the
 * parent is itself customisable (the buyer hasn't yet chosen a day count, so
 * there is no single render-time duration). Specialises the shared
 * {@link childDaysFromParent}: customisable → null, standard → 1. */
const parentRenderDuration = (parent: ListingWithCount): number | null =>
  childDaysFromParent<number | null>(parent, null, 1);

/** The "from" price for a customisable child under a customisable parent: the
 * minimum child day price over the spans the parent can ACTUALLY offer (parent's
 * selectable counts ∩ child's priced counts). Using the child's own lowest span
 * ignores the parent's range, so a parent offering only {3} days with a child
 * priced {1:£10, 3:£25} would advertise "from £10" while checkout (inheriting the
 * 3-day span) charges £25. Returns null when the spans don't intersect
 * (such an edge isn't bookable anyway), so the label is omitted. */
const childFromPrice = (
  child: ListingWithCount,
  parent: ListingWithCount,
): number | null => {
  const childSpans = new Set(availableDayCounts(child));
  const prices = pipe(
    filter((n: number) => childSpans.has(n)),
    mapNotNullish((n) => dayPriceFor(child, n)),
  )(availableDayCounts(parent));
  return prices.length === 0 ? null : Math.min(...prices);
};

/** The numeric price shown for a child under a parent, in minor units, or null
 * when the child has no price for the inherited / overlapping span (defensive —
 * admin blocks such edges). A customisable child is priced by the inherited
 * duration, NOT its `unit_price` (0 for a free-input customisable listing, which
 * would advertise "free" while checkout charges the day price): the fixed
 * inherited day price under a fixed-duration parent, or the minimum day price over
 * the parent∩child spans under a customisable parent. A fixed-price child returns
 * its `unit_price` unchanged. The single source of truth both the label below and
 * the render-time "all free" check consume. */
const childPriceMinor = (
  child: ListingWithCount,
  parent: ListingWithCount,
): number | null => {
  if (!child.customisable_days) return child.unit_price;
  const duration = parentRenderDuration(parent);
  // Customisable parent, no single duration yet: price by the cheapest span the
  // parent can actually offer (parent∩child counts).
  // A fixed-duration parent prices the child at the inherited duration;
  // `dayPriceFor` returns null for an out-of-range span ⇒ null (admin blocks an
  // unpriced inherited span).
  return duration === null
    ? childFromPrice(child, parent)
    : dayPriceFor(child, duration);
};

/** The price label shown in a child option's label: `(£X)` for a fixed/inherited
 * price, or `from £X` for a customisable child under a customisable parent (no
 * single render-time duration yet). Omitted (empty) when the child has no price for
 * the inherited / overlapping span, or — when `showZero` is false — when the price
 * is exactly £0. The block hides every child's price when ALL bookable children are
 * free, so a solo free child shows no "(£0)" and an all-free selector drops every
 * price; one paid sibling among free children keeps all prices (including the £0
 * ones) so the buyer can compare. */
const childPriceLabel = (
  child: ListingWithCount,
  parent: ListingWithCount,
  showZero = true,
): string => {
  const price = childPriceMinor(child, parent);
  if (price === null) return "";
  if (price === 0 && !showZero) return "";
  // A customisable child under a customisable parent (no single duration yet)
  // advertises "from <min day price>"; every other case shows the fixed price.
  if (child.customisable_days && parentRenderDuration(parent) === null) {
    return t("public.ticket.child_from_price", {
      price: formatCurrency(price),
    });
  }
  return `(${formatCurrency(price)})`;
};

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

/** The child's own (non-required) pay-more price input, or empty when the child
 * isn't a pay-more listing. Shared by the selectable and sole-child renderers,
 * which both offer this same input for a pay-more child. */
const childPayMoreInput = (
  parentId: number,
  listing: ListingWithCount,
): string =>
  listing.can_pay_more
    ? renderPayMoreInput(
        listing,
        childPriceFieldName(parentId, listing.id),
        undefined,
        false,
      )
    : "";

/** The shared inputs for rendering one of a parent's children: the parent
 * listing, the child itself, the child's date/span lookup, and whether £0 prices
 * are shown. Both the selectable and sole-child renderers take one. */
type ChildOptionCtx = {
  parent: ListingWithCount;
  child: TicketListing;
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>;
  showZero: boolean;
};

/** The parent id and child listing both renderers pull off the context before
 * building the child's markup. */
const childRefs = (
  ctx: ChildOptionCtx,
): { parentId: number; listing: ListingWithCount } => ({
  listing: ctx.child.listing,
  parentId: ctx.parent.id,
});

/** Render one child as a per-unit quantity row: a `child_qty_<parentId>_<childId>`
 * select over `0..childLimit`, plus — for a bookable pay-more child — its
 * non-required price input. A sold-out/closed/inactive child renders a disabled
 * select fixed at 0, never selectable. The select is non-required in
 * markup; the server fold validates the per-parent total. A bookable
 * child also carries its date/span compatibility attributes ({@link
 * childDateAttrs}) for the client compatibility script. */
const renderChildOption = (ctx: ChildOptionCtx, childLimit: number): string => {
  const { parentId, listing } = childRefs(ctx);
  const bookable = childCanBeBooked(ctx.child);
  const selectName = childQuantityFieldName(parentId, listing.id);
  // Only a bookable pay-more child offers the price input here.
  const priceHtml = bookable ? childPayMoreInput(parentId, listing) : "";
  const label = bookable
    ? `${escapeHtml(listing.name)} ${childPriceLabel(
        listing,
        ctx.parent,
        ctx.showZero,
      )}`.trim()
    : escapeHtml(t("public.ticket.child_unavailable", { name: listing.name }));
  const select = bookable
    ? `<select name="${selectName}" data-child-qty="${listing.id}"${childDateAttrs(
        parentId,
        ctx.child,
        ctx.childDatesById,
      )}>${quantityOptions(
        childLimit,
        restoredChildQty(parentId, listing.id, childLimit),
      )}</select>`
    : `<select name="${selectName}" disabled><option value="0" selected>0</option></select>`;
  return `<label class="child-option">${select} ${label}</label>${priceHtml}`;
};

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
const renderSoleChildOption = (ctx: ChildOptionCtx): string => {
  const { parentId, listing } = childRefs(ctx);
  const priceHtml = childPayMoreInput(parentId, listing);
  const visible = !listing.hidden;
  const namePart = visible ? escapeHtml(listing.name) : "";
  const pricePart = visible
    ? childPriceLabel(listing, ctx.parent, ctx.showZero)
    : "";
  const label = `${namePart} ${pricePart}`.trim();
  return `<p class="child-option child-sole" data-sole-parent="${parentId}" data-sole-child="${listing.id}"${childDateAttrs(
    parentId,
    ctx.child,
    ctx.childDatesById,
  )}>${label}</p>${priceHtml}`;
};

/**
 * Render the per-parent child block: a `child_qty_<parentId>_<childId>` select per
 * child, a "Choose <Q> add-on(s) in total" note plus a live "X of Q chosen" hint,
 * each bookable pay-more child's price input, and the children's questions (deduped,
 * non-required). A SOLE bookable child renders as informational (auto-select
 * preserved, see {@link renderSoleChildOption}). Empty string when the parent has
 * no children. Requiredness/totals are enforced server-side.
 */
const renderChildBlock = (
  parentInfo: TicketListing,
  ctx: ChildRenderCtx,
  packageFixedQty?: number,
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
      const optionCtx: ChildOptionCtx = {
        child,
        childDatesById: ctx.childDatesById,
        parent,
        showZero,
      };
      return isSole(child)
        ? renderSoleChildOption(optionCtx)
        : renderChildOption(
            optionCtx,
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
  // A package member parent has no quantity_<id> control, so the client scripts
  // derive its booked units from this fixed per-package quantity × the chosen
  // package count.
  const fixedQtyAttr =
    packageFixedQty === undefined
      ? ""
      : ` data-package-fixed-qty="${packageFixedQty}"`;
  return (
    `<fieldset class="child-selector" data-parent-id="${parentId}"${fixedQtyAttr}>` +
    `${legend}${note}${options}${questionsHtml}</fieldset>`
  );
};

/** The two figures both listing renderers open with: how many of this listing
 * can still be bought, and the quantity field name for its booking node. A
 * top-level booking node always carries a buyer-chosen quantity field. */
const listingRowBasics = (
  info: TicketListing,
  node: BookingNode,
  childCtx: ChildRenderCtx | undefined,
): { maxPurchasable: number; fieldName: string } => ({
  fieldName: nodeQuantityFieldName(node)!,
  maxPurchasable: childLimitedMax(info, childCtx),
});

/** Render quantity selector for an listing row.
 *
 * An optional per-listing `prefill` pre-selects the quantity (clamped to the
 * available range) — used by multi-listing scenarios such as the order cart. */
const renderListingRow = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity = false,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const { listing, isSoldOut, isClosed } = info;
  const { maxPurchasable, fieldName } = listingRowBasics(info, node, childCtx);
  const imageHtml = renderListingImage(listing);

  if (isClosed) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        <span class="sold-out-label">${t("public.registration_closed")}</span>
      </div>
    `;
  }

  if (isSoldOut) {
    return `
      <div class="ticket-row sold-out">
        ${imageHtml}
        <label>${escapeHtml(listing.name)}</label>
        ${renderListingDescription(listing.description)}
        <span class="sold-out-label">${t("public.sold_out")}</span>
      </div>
    `;
  }

  const quantityHtml = hideQuantity
    ? `<input type="hidden" name="${fieldName}" value="1" />`
    : `<select name="${fieldName}">${quantityOptions(
        maxPurchasable,
        restoredQuantity(listing.id, prefill, maxPurchasable),
      )}</select>`;

  const showPayMore = listing.can_pay_more;
  const prefilledPrice = prefill ? prefill.customPriceMinor : undefined;
  const childBlock = childCtx ? renderChildBlock(info, childCtx) : "";

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(listing.name)}${quantityHtml}</label>
      ${renderListingDescription(listing.description)}
      ${
        showPayMore
          ? renderPayMoreInput(
              listing,
              nodePriceFieldName(node)!,
              prefilledPrice,
            )
          : ""
      }
      ${childBlock}
    </div>
  `;
};

/** A package member row: name + fixed per-package quantity, read-only — the
 * buyer chooses the package count, not per-member quantities. A member that is
 * itself a parent renders its child selector under the row, exactly like a
 * standalone parent (only VISIBLE packages may contain parents, so a hidden
 * package never reaches the child block). */
const renderPackageMemberRow = (
  info: TicketListing,
  fixedQty: number,
  childCtx: ChildRenderCtx | undefined,
): string => `
    <div class="ticket-row package-member">
      ${renderListingImage(info.listing)}
      <label>${escapeHtml(
        info.listing.name,
      )} <span class="package-member-qty">&times;${fixedQty}</span></label>
      ${renderListingDescription(info.listing.description)}
      ${childCtx ? renderChildBlock(info, childCtx, fixedQty) : ""}
    </div>
  `;

/** A package booking page's listing area: the single "number of packages"
 * selector, then each member row (each showing its fixed quantity) — unless the
 * package hides its listings from buyers, in which case only the selector shows.
 * `limit` is the most packages the buyer can book. */
const renderPackageRows = (
  listings: TicketListing[],
  quantities: ReadonlyMap<number, number>,
  limit: number,
  hide: boolean,
  childCtx: ChildRenderCtx | undefined,
): string => {
  // Every member listing id, so the client knows which listing-scoped questions
  // to show/require once a package is selected — even when members are hidden and
  // render no rows of their own.
  const memberIds = listings.map((e) => e.listing.id).join(" ");
  const selector = `<label>${t(
    "public.package.quantity",
  )}<select name="${PACKAGE_QUANTITY_FIELD}" data-package-members="${memberIds}">${quantityOptions(
    limit,
    restoredPackageQuantity(limit),
  )}</select></label>`;
  const members = hide
    ? ""
    : listings
        .map((e) =>
          renderPackageMemberRow(
            e,
            quantities.get(e.listing.id) ?? 1,
            childCtx,
          ),
        )
        .join("");
  return selector + members;
};

/** Render controls for a single listing: quantity input + pay-more (no listing name/image/description). */
const renderSingleListingControls = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity: boolean,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const { listing } = info;
  const { maxPurchasable, fieldName } = listingRowBasics(info, node, childCtx);
  const prefilledQty = restoredQuantity(listing.id, prefill, maxPurchasable);
  const prefilledPrice = prefill ? prefill.customPriceMinor : undefined;
  const quantityHtml = hideQuantity
    ? `<input type="hidden" name="${fieldName}" value="1" />`
    : `<label>${t(
        "public.ticket.number_of_tickets",
      )}<select name="${fieldName}">${quantityOptions(
        maxPurchasable,
        prefilledQty,
      )}</select></label>`;
  const showPayMore = listing.can_pay_more;
  const childBlock = childCtx ? renderChildBlock(info, childCtx) : "";
  return `${quantityHtml}${
    showPayMore
      ? renderPayMoreInput(listing, nodePriceFieldName(node)!, prefilledPrice)
      : ""
  }${childBlock}`;
};

/** The merged fields setting across the selected listings. */
const getTicketFieldsSetting = (listings: TicketListing[]): ListingFields =>
  mergeListingFields(listings.map((e) => e.listing.fields));

/**
 * The contact fields rendered on the booking form: every page listing's fields
 * (required) PLUS any extra field a possible child requires. A child with stricter
 * `fields` than its parent (e.g. parent collects email, child also wants
 * phone/address) is validated server-side for the *selected* child, but the buyer
 * must SEE that field to fill it — so it is rendered here NON-required (mirroring
 * the provider-email/`anyPaid` handling), since an unselected child or a
 * zero-quantity parent must not block submission. The page fields keep `required`.
 */
const buildContactFields = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  pagePaid: boolean,
  anyPaid: boolean,
): Field[] => {
  const pageSetting = getTicketFieldsSetting(listings);
  const children = childrenByParentId
    ? [...childrenByParentId.values()].flat()
    : [];
  const childSetting = mergeListingFields(
    children.map((e) => e.listing.fields),
  );
  const mergedSetting = mergeListingFields([pageSetting, childSetting]);
  // The provider-imposed paid email is a required page field only when the PAGE
  // itself is paid; a free page with a paid child renders it non-required (enforced
  // server-side once the folded order is actually paid). So `pageNames` uses
  // `pagePaid` while the rendered set uses `anyPaid` (so the email is present at all).
  const pageNames = new Set<string>(
    getTicketFields(pageSetting, pagePaid).map((f) => f.name),
  );
  return getTicketFields(mergedSetting, anyPaid).map((f) =>
    pageNames.has(f.name) ? f : { ...f, required: false },
  );
};

/**
 * Pre-fill for the booking page: per-listing quantities (and optional price), an
 * optional pre-filled name/date, and — only for signed QR links — a token
 * re-submitted as a hidden field to authorise a price override. Any scenario that
 * lands a visitor on a booking form with listings pre-selected builds one: the QR
 * flow sets a single listing plus a `token`; the order cart sets many listings
 * (quantity 1 each) and no token.
 */
export type BookingPrefill = {
  /** Per-listing pre-fill — keyed by listing id */
  listings: Map<number, TicketPrefill>;
  /** Pre-fill name input */
  name?: string;
  /** Pre-fill date selector (for daily listings) */
  date?: string;
  /** Opaque signed token re-submitted via a hidden input to verify a price
   * override. Only signed QR booking links set this. */
  token?: string;
};

/** Alias retained for the signed-QR booking flow, which always sets `token`. */
export type QrPrefill = BookingPrefill;

/** Options for the ticket page */
export type TicketPageOptions = {
  listings: TicketListing[];
  slugs: string[];
  error?: string;
  dates?: string[];
  terms?: string | null;
  questions?: QuestionWithAnswers[];
  questionListingMap?: QuestionListingMap;
  baseUrl?: string;
  groupName?: string;
  groupDescription?: string;
  groupImage?: ItemImageProjection;
  prefill?: BookingPrefill | undefined;
  /** Override the <form action="…"> URL. Defaults to `/ticket/<slugs>`. */
  actionUrl?: string;
  /** Opt-in add-ons to offer below the questions. */
  addOns?: AddOnOption[];
  /** Whether to offer a promo-code field. */
  promoCodesEnabled?: boolean;
  /** Parent listing id → its children. Drives the per-parent child selector
   * rendered under each parent row. */
  childrenByParentId?: Map<number, TicketListing[]>;
  /** Daily-child start dates for each parent day count. */
  childDatesById?: ReadonlyMap<string, ChildDatesByDayCount>;
  /** Remaining spots for limited groups. */
  groupRemainingByGroupId?: ReadonlyMap<number, number>;
  /** Groups each listing belongs to. */
  groupIdsByListingId?: ReadonlyMap<number, number[]>;
  /** Package overrides (listing id → price) when this is a package page, so a
   * member whose base price is 0 but override is paid still renders the provider
   * contact fields. Empty/omitted for non-package pages. */
  packagePrices?: ReadonlyMap<number, number> | null | undefined;
  /** A package page's per-member per-day overrides (listing id → day count →
   * minor units), so the tree's `DAY_PRICE` rules — and the day-count selector's
   * bundle totals — price by the package's entered day prices. */
  packageDayPrices?:
    | ReadonlyMap<number, ReadonlyMap<number, number>>
    | null
    | undefined;
  /** Set on a package page: the group id, each member's fixed per-package
   * quantity, and whether members are hidden from buyers. When set, the page
   * shows one package-quantity selector instead of per-member quantities. */
  packageGroupId?: number | null;
  packageQuantities?: ReadonlyMap<number, number> | null;
  /** Remaining spots for package member groups. */
  packageGroupRemainingByGroupId?: ReadonlyMap<number, number>;
  packageMemberGroupIds?: ReadonlyMap<number, number[]>;
  hidePackageListings?: boolean;
};

/** Unavailability message shown when all listings are sold out or closed */
const unavailableMessage = (
  allClosed: boolean,
  isSingleListing: boolean,
): string => {
  if (isReadOnly() || allClosed) return t("public.ticket.registration_closed");
  return isSingleListing
    ? t("public.ticket.listing_full")
    : t("public.multi.all_sold_out");
};

/** Header block shown above the form with listing/group details */
const TicketPageHeader = ({
  headerName,
  headerDescription,
  headerImage,
  singleListing,
  pastDays,
}: {
  headerName: string;
  headerDescription: string | null | undefined;
  headerImage: ItemImageProjection | null;
  singleListing: ListingWithCount | null;
  pastDays: number | null;
}): JSX.Element => (
  <>
    {headerImage && <Raw html={renderListingImage(headerImage)} />}
    <div class="prose">
      <h1>{headerName}</h1>
      {headerDescription && (
        <div class="description">
          <Raw html={renderMarkdown(headerDescription)} />
        </div>
      )}
      {singleListing?.date && (
        <p>
          <strong>{t("public.ticket.date_label")}</strong>{" "}
          {formatDatetimeLabel(singleListing.date)}
          {pastDays !== null && (
            <Badge variant="alert">
              {" "}
              {t("public.ticket.days_ago", { count: pastDays })}
            </Badge>
          )}
        </p>
      )}
      {singleListing?.location && (
        <p>
          <strong>{t("public.ticket.location_label")}</strong>{" "}
          {singleListing.location}
        </p>
      )}
    </div>
  </>
);

/** Opt-in add-on selectors: one quantity input per add-on, defaulting to 0
 * (not selected) and restored on validation error. */
const AddOnsFieldset = ({ addOns }: { addOns: AddOnOption[] }): JSX.Element => (
  <fieldset class="ticket-addons">
    <legend>{t("public.addons.heading")}</legend>
    {addOns.map((addOn) => {
      const field = `addon_${addOn.id}`;
      return (
        <label class="addon-row">
          <span class="addon-name">
            {addOn.name} <span class="addon-price">({addOn.priceLabel})</span>
          </span>
          <input
            aria-label={`${addOn.name} — ${t("public.addons.quantity")}`}
            max={String(addOn.maxQuantity)}
            min="0"
            name={field}
            placeholder="0"
            type="number"
            value={savedFormValue(field)}
          />
        </label>
      );
    })}
  </fieldset>
);

/** Promo-code text input, shown when any active modifier is unlocked by a code.
 * The entered value is restored on a validation-error re-render. */
const PromoCodeField = (): JSX.Element => (
  <div class="promo-code">
    <label>
      {t("public.promo.heading")}
      <input
        name="promo_code"
        placeholder={t("public.promo.placeholder")}
        type="text"
        value={savedFormValue("promo_code")}
      />
    </label>
    <p class="hint">{t("public.promo.hint")}</p>
  </div>
);

/** The "number of days" selector inputs a page derives from its listings:
 * whether any listing is customisable-days, the day-count options, and (on a
 * single-listing page) a per-option pricer. Shared by {@link dayConfig}'s
 * result and the {@link TicketPageForm} props so the shape can't drift. */
type DayCountConfig = {
  hasCustomisable: boolean;
  dayCounts: number[];
  dayCountPriceFor?: ((days: number) => number | null) | undefined;
};

/** Form body with fields, date selector, listing rows, questions, terms, and submit */
const TicketPageForm = ({
  slugs,
  actionUrl,
  fields,
  hasDaily,
  durationDays,
  dates,
  hasCustomisable,
  dayCounts,
  dayCountPriceFor,
  listingRows,
  hideQuantity,
  isPackage,
  isSingleListing,
  questions,
  questionListingMap,
  terms,
  prefill,
  addOns,
  promoCodesEnabled,
}: {
  slugs: string[];
  actionUrl?: string | undefined;
  fields: Field[];
  hasDaily: boolean;
  durationDays: number;
  dates: string[] | undefined;
  listingRows: string;
  hideQuantity: boolean;
  isPackage: boolean;
  isSingleListing: boolean;
  questions: QuestionWithAnswers[] | undefined;
  questionListingMap: QuestionListingMap | undefined;
  terms: string | null | undefined;
  prefill?: BookingPrefill | undefined;
  addOns: AddOnOption[] | undefined;
  promoCodesEnabled: boolean | undefined;
} & DayCountConfig): JSX.Element => {
  const fieldValues: Record<string, string> = {};
  if (prefill?.name) fieldValues.name = prefill.name;
  return (
    <CsrfForm action={actionUrl ?? `/ticket/${slugs.join("+")}`}>
      {prefill?.token && (
        <input name="qr_token" type="hidden" value={prefill.token} />
      )}
      <Raw html={renderFields(fields, fieldValues)} />
      {hasDaily && dates && (
        <Raw
          html={renderDateSelector(
            dates,
            savedFormValue("date") || prefill?.date || "",
            durationDays,
          )}
        />
      )}
      {hasCustomisable && (
        <Raw html={renderDayCountSelector(dayCounts, dayCountPriceFor)} />
      )}

      {hideQuantity || isSingleListing || isPackage ? (
        <Raw html={listingRows} />
      ) : (
        <fieldset class="ticket-listings">
          <legend>{t("public.multi.select_tickets")}</legend>
          <Raw html={listingRows} />
        </fieldset>
      )}

      {questions &&
        questions.length > 0 &&
        renderQuestions(questions, questionListingMap)}
      {addOns && addOns.length > 0 && <AddOnsFieldset addOns={addOns} />}
      {promoCodesEnabled && <PromoCodeField />}
      {terms && <Raw html={renderTermsAndCheckbox(terms)} />}
      {/* Continue is rendered first so it stays the form's default submit: an
          implicit submit (Enter in a text field) completes the booking, not the
          running total's /calculate action. */}
      <button type="submit">{t("common.continue")}</button>
      {!actionUrl && (
        <div class="running-total">
          <button
            data-running-total
            formaction={`/calculate/${slugs.join("+")}`}
            formnovalidate
            formtarget="_blank"
            type="submit"
          >
            {t("public.ticket.show_total")}
          </button>
          <output class="order-summary-output" data-running-total-output />
        </div>
      )}
    </CsrfForm>
  );
};

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

/** The day-count option pricer for a page: a customisable PACKAGE prices each
 * option as the whole bundle's total; every other page keeps the pricer
 * {@link dayConfig} resolved (the single listing's own day prices, or none). */
const resolveDayCountPriceFor = (
  isPackage: boolean,
  tree: BookingTree,
  bookableChildren: ReadonlySet<number>,
  dayCfg: DayCountConfig,
): ((days: number) => number | null) | undefined =>
  isPackage && dayCfg.hasCustomisable
    ? packageDayCountPriceFor(tree, bookableChildren)
    : dayCfg.dayCountPriceFor;

/**
 * Day-selection config for the booking form, derived from the page's listings.
 * Customisable-days listings drive a shared "number of days" selector; on a
 * single-listing page each option carries its price, and the date selector's
 * duration label is suppressed (the span is chosen, not fixed).
 */
const dayConfig = (
  listings: TicketListing[],
  singleListing: ListingWithCount | null,
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  isPackage: boolean,
): DayCountConfig & { dateDurationDays: number } => ({
  dateDurationDays:
    singleListing && !singleListing.customisable_days
      ? singleListing.duration_days
      : 1,
  dayCountPriceFor: singleListing?.customisable_days
    ? (days: number) => dayPriceFor(singleListing, days)
    : undefined,
  // A package books every member, so each parent member's child union
  // constrains the bundle's spans; other pages constrain only the
  // single-listing-parent case.
  dayCounts:
    isPackage && childrenByParentId
      ? packageDayCountsChildrenSupport(listings, childrenByParentId)
      : keepParentDayCountsChildrenSupport(
          listings,
          dayCountsEveryListingSupports(listings),
          childrenByParentId,
        ),
  hasCustomisable: listings.some((e) => e.listing.customisable_days),
});

/** The group + children lookups a package or child-bearing page threads through
 * its render helpers: each parent's children, plus the remaining spots and group
 * memberships used to cap group/package capacity. Bundled so the same cluster of
 * arguments isn't spelled out on every helper that needs them. */
type GroupLookups = {
  childrenByParentId: Map<number, TicketListing[]> | undefined;
  groupRemainingByGroupId: ReadonlyMap<number, number>;
  groupIdsByListingId: ReadonlyMap<number, number[]>;
};

/**
 * Split the page's questions into the page-level set (rendered required in the main
 * block) and the per-parent child render context (child-only questions rendered
 * non-required under their parent). A question shared by a page listing and a child
 * renders at page level once, so the child ctx's `rendered` set is pre-seeded with
 * the page question ids. Without parents the page set is unchanged and there is no
 * child ctx.
 */
const splitChildQuestions = (
  listings: TicketListing[],
  questions: QuestionWithAnswers[],
  questionListingMap: QuestionListingMap | undefined,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
  groups: GroupLookups,
): { pageQuestions: QuestionWithAnswers[]; childCtx?: ChildRenderCtx } => {
  const { childrenByParentId, groupRemainingByGroupId, groupIdsByListingId } =
    groups;
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

/** A package page's price overrides: a flat per-member override (listing id →
 * minor units) and per-day overrides (listing id → day count → minor units).
 * Both empty/absent on a non-package page. Bundled so the paid-in-context checks
 * don't each re-declare the same pair of parameters. */
type PackagePriceOverrides = {
  packagePrices: ReadonlyMap<number, number> | null | undefined;
  packageDayPrices:
    | ReadonlyMap<number, ReadonlyMap<number, number>>
    | null
    | undefined;
};

/** Whether a listing is paid in context. A flat package override REPLACES the
 * base price for this purpose: a member with one is paid only when it is
 * positive (an explicit free 0 makes a paid base listing free here). Without a
 * flat override, a positive per-day package override makes the member paid for
 * that span — an otherwise-free customisable member must still render the
 * provider contact fields — and the listing's own pricing covers the rest. */
const paidInContext = (
  listing: TicketListing,
  overrides: PackagePriceOverrides,
): boolean => {
  const { packagePrices, packageDayPrices } = overrides;
  const override = packagePrices?.get(listing.listing.id);
  if (override !== undefined) return override > 0;
  const dayOverrides = packageDayPrices?.get(listing.listing.id);
  if (dayOverrides && [...dayOverrides.values()].some((p) => p > 0)) {
    return true;
  }
  return isPaidListing(listing.listing);
};

/** Whether the page itself (its listings or add-ons, NOT possible children) is
 * paid — so its provider-imposed email renders required. */
const pagePaid = (
  listings: TicketListing[],
  addOns: AddOnOption[] | undefined,
  overrides: PackagePriceOverrides,
): boolean =>
  listings.some((e) => paidInContext(e, overrides)) ||
  (addOns?.some((addOn) => addOn.requiresPayment) ?? false);

/** Whether the contact-field set must include a paid order's provider-imposed
 * fields: any page listing, possible child, or add-on is paid. A free parent with
 * a paid child still needs the email field present (non-required, enforced
 * server-side when the folded order is actually paid). */
const pageOrChildPaid = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  addOns: AddOnOption[] | undefined,
  overrides: PackagePriceOverrides,
): boolean => {
  const children = childrenByParentId
    ? [...childrenByParentId.values()].flat()
    : [];
  return (
    pagePaid(listings, addOns, overrides) ||
    children.some((e) => isPaidListing(e.listing))
  );
};

/** Render the per-listing rows (with their child blocks). A single-listing page
 * shows just the controls (details live in the header); multi-listing pages
 * show a compact row each. Both honour per-listing quantity pre-fills. */
const buildListingRows = (
  listings: TicketListing[],
  nodeByListingId: ReadonlyMap<number, BookingNode>,
  isSingleListing: boolean,
  hideQuantity: boolean,
  prefill: BookingPrefill | undefined,
  childCtx: ChildRenderCtx | undefined,
): string =>
  isSingleListing
    ? renderSingleListingControls(
        listings[0]!,
        nodeByListingId.get(listings[0]!.listing.id)!,
        hideQuantity,
        prefill?.listings.get(listings[0]!.listing.id),
        childCtx,
      )
    : listings
        .map((e) =>
          renderListingRow(
            e,
            nodeByListingId.get(e.listing.id)!,
            hideQuantity,
            prefill?.listings.get(e.listing.id),
            childCtx,
          ),
        )
        .join("");

/** Build the page's listing area: a package shows one package-quantity selector
 * plus read-only member rows; any other page shows the per-listing controls. */
const buildPageListingRows = (opts: {
  isPackage: boolean;
  listings: TicketListing[];
  nodeByListingId: ReadonlyMap<number, BookingNode>;
  packageQuantities: ReadonlyMap<number, number> | null | undefined;
  packageLimit: number;
  hidePackageListings: boolean;
  isSingleListing: boolean;
  hideQuantity: boolean;
  prefill?: BookingPrefill | undefined;
  childCtx?: ChildRenderCtx | undefined;
}): string => {
  if (opts.isPackage) {
    const quantities = opts.packageQuantities ?? new Map<number, number>();
    return renderPackageRows(
      opts.listings,
      quantities,
      opts.packageLimit,
      opts.hidePackageListings,
      opts.childCtx,
    );
  }
  return buildListingRows(
    opts.listings,
    opts.nodeByListingId,
    opts.isSingleListing,
    opts.hideQuantity,
    opts.prefill,
    opts.childCtx,
  );
};

/** Package limit for this page, plus whether it should show as sold out. */
const packagePageAvailability = (
  isPackage: boolean,
  tree: BookingTree,
  listings: TicketListing[],
  groups: GroupLookups,
): { packageLimit: number; soldOut: boolean } => {
  const { childrenByParentId, groupRemainingByGroupId, groupIdsByListingId } =
    groups;
  const limit = isPackage
    ? packageBundleLimit(
        tree,
        packageLimitInfo(
          listings,
          childrenByParentId,
          groupRemainingByGroupId,
          groupIdsByListingId,
        ),
      )
    : null;
  const membersUnavailable = listings.every((e) => e.isSoldOut || e.isClosed);
  return {
    packageLimit: limit ?? 0,
    soldOut: membersUnavailable || limit === 0,
  };
};

/** The lone listing whose rich details (image/date/location) head the page and
 * feed its OpenGraph tags, or null for a multi-listing page OR a hidden package
 * — a hidden package with one active member must not expose that member here. */
const headerListing = (
  listings: TicketListing[],
  hidePackageListings: boolean,
): ListingWithCount | null =>
  listings.length === 1 && !hidePackageListings ? listings[0]!.listing : null;

const ticketPageHeadExtra = (
  headerImage: ItemImageProjection | null,
  headerName: string | undefined,
  headerDescription: string | null | undefined,
  slugs: string[],
  baseUrl: string | undefined,
): string | undefined => {
  if (!headerImage || !headerName || !baseUrl) return undefined;
  return buildOgTags(
    {
      description: headerDescription,
      image_alt_text: headerImage.image_alt_text,
      image_url: headerImage.image_url,
      name: headerName,
      slug: slugs.join("+"),
    },
    baseUrl,
  );
};

/**
 * Ticket page - register for one or more listings
 * Single listings show rich details (image, description, date, location).
 * Multiple listings show a compact row layout with per-listing quantity selectors.
 */
export const ticketPage = ({
  listings,
  slugs,
  error,
  dates,
  terms,
  questions,
  questionListingMap,
  baseUrl,
  groupName,
  groupDescription,
  groupImage,
  prefill,
  actionUrl,
  addOns,
  promoCodesEnabled,
  childrenByParentId,
  childDatesById,
  groupRemainingByGroupId = new Map(),
  groupIdsByListingId = new Map(),
  packagePrices,
  packageDayPrices,
  packageGroupId,
  packageQuantities,
  packageGroupRemainingByGroupId = new Map(),
  packageMemberGroupIds = new Map(),
  hidePackageListings = false,
}: TicketPageOptions): string => {
  // getTicketContext always sets packageQuantities alongside packageGroupId.
  const isPackage = packageGroupId != null;
  // The canonical booking tree drives node identity + the stable form field names
  // (via nodeQuantityFieldName/nodePriceFieldName); render output is unchanged.
  const treeInput: BuildTreeInput = {
    childrenByParentId,
    hidePackageListings,
    listings,
    packageDayPrices,
    packagePrices,
    packageQuantities,
    root:
      packageGroupId != null
        ? { groupId: packageGroupId, kind: "package" }
        : undefined,
    slugs,
  };
  const tree = buildBookingTree(treeInput);
  const nodeByListingId = new Map(
    tree.nodes.map((node) => [node.listingId, node]),
  );
  const inIframe = getIframeMode();
  const { packageLimit, soldOut: allUnavailable } = packagePageAvailability(
    isPackage,
    tree,
    listings,
    {
      childrenByParentId,
      groupIdsByListingId: packageMemberGroupIds,
      groupRemainingByGroupId: packageGroupRemainingByGroupId,
    },
  );
  const allClosed = listings.every((e) => e.isClosed);
  const priceOverrides = { packageDayPrices, packagePrices };
  const fields: Field[] = buildContactFields(
    listings,
    childrenByParentId,
    pagePaid(listings, addOns, priceOverrides),
    pageOrChildPaid(listings, childrenByParentId, addOns, priceOverrides),
  );
  const hasDaily = listings.some((e) => e.listing.listing_type === "daily");

  const singleListing = headerListing(listings, hidePackageListings);
  const isSingleListing = singleListing !== null;
  const pastDays = singleListing?.date ? daysAgo(singleListing.date) : null;

  const dayCfg = dayConfig(
    listings,
    singleListing,
    childrenByParentId,
    isPackage,
  );
  const { hasCustomisable, dayCounts, dateDurationDays } = dayCfg;
  const dayCountPriceFor = resolveDayCountPriceFor(
    isPackage,
    tree,
    bookableChildIds(childrenByParentId),
    dayCfg,
  );

  const availableListings = listings.filter((e) => !e.isSoldOut && !e.isClosed);
  const hideQuantity =
    availableListings.length === 1 &&
    availableListings[0]?.maxPurchasable === 1;

  const { pageQuestions, childCtx } = splitChildQuestions(
    listings,
    questions ?? [],
    questionListingMap,
    childDatesById ?? new Map(),
    {
      childrenByParentId,
      groupIdsByListingId,
      groupRemainingByGroupId,
    },
  );

  // A package page shows one "number of packages" selector plus read-only member
  // rows (each ×its fixed quantity); other pages show per-listing controls.
  const listingRows = buildPageListingRows({
    childCtx,
    hidePackageListings,
    hideQuantity,
    isPackage,
    isSingleListing,
    listings,
    nodeByListingId,
    packageLimit,
    packageQuantities,
    prefill,
  });

  // Caller-supplied group metadata (groups, renewals) takes priority over
  // single-listing details — the caller knows what page the customer landed on.
  // Plain single-listing pages set no group metadata and fall back to listing
  // name/description.
  const headerName = groupName ?? singleListing?.name;
  const headerDescription = groupDescription ?? singleListing?.description;
  const headerImage = groupImage?.image_url ? groupImage : singleListing;
  const title = headerName || t("public.multi.title");
  const headExtra = ticketPageHeadExtra(
    headerImage,
    headerName,
    headerDescription,
    slugs,
    baseUrl,
  );

  return String(
    <Layout
      bodyClass={inIframe ? "iframe" : undefined}
      headExtra={headExtra}
      title={title}
    >
      {headerName && !inIframe && (
        <TicketPageHeader
          headerDescription={headerDescription}
          headerImage={headerImage}
          headerName={headerName}
          pastDays={pastDays}
          singleListing={singleListing}
        />
      )}
      <Flash error={error} />

      {allUnavailable || isReadOnly() ? (
        <div class="error" role="alert">
          {unavailableMessage(allClosed, isSingleListing)}
        </div>
      ) : (
        <TicketPageForm
          actionUrl={actionUrl}
          addOns={addOns}
          dates={dates}
          dayCountPriceFor={dayCountPriceFor}
          dayCounts={dayCounts}
          durationDays={dateDurationDays}
          fields={fields}
          hasCustomisable={hasCustomisable}
          hasDaily={hasDaily}
          hideQuantity={hideQuantity}
          isPackage={isPackage}
          isSingleListing={isSingleListing}
          listingRows={listingRows}
          prefill={prefill}
          promoCodesEnabled={promoCodesEnabled}
          questionListingMap={questionListingMap}
          questions={pageQuestions}
          slugs={slugs}
          terms={terms}
        />
      )}
    </Layout>,
  );
};
