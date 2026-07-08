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
  packageChildTicketLimits,
  packageLimitInfo,
  pagePackageBundleLimit,
} from "#shared/booking/package-cap.ts";
import {
  explicitStandaloneIds,
  type PagePackage,
  packageMemberIds,
} from "#shared/booking/page-packages.ts";
import { packageBundleTotal } from "#shared/booking/price-tree.ts";
import {
  type BookingNode,
  type BookingTree,
  childPriceFieldName,
  childQuantityFieldName,
  nodePriceFieldName,
  nodeQuantityFieldName,
  packageQuantityFieldName,
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
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { mergeListingFields } from "#shared/listing-fields.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type Image,
  type ItemImageProjection,
  isPaidListing,
  type ListingFields,
  type ListingWithCount,
} from "#shared/types.ts";
import { Badge } from "#templates/components/badge.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { moneyPattern } from "#templates/components/price-input.tsx";
import {
  questionFieldset,
  questionWrapper,
} from "#templates/components/question-text.tsx";
import { getTicketFields } from "#templates/fields/ticket.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import { PublicImageGallery, renderListingImage } from "./shared.tsx";
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
    ? `<div class="error">${t("public.ticket.no_dates_available")}</div>`
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
    return `<div class="error">${t("public.ticket.no_booking_lengths")}</div>`;
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
    return questionWrapper(q, listingIds, (labelledBy) => (
      <input
        aria-labelledby={labelledBy}
        maxlength={MAX_TEXTAREA_LENGTH}
        name={`question_${q.id}`}
        required={required}
        type="text"
        value={answered}
      />
    ));
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

/** One package's count to pre-select: the value the buyer just submitted
 * (restored when a validation error re-renders the page) clamped to the limit,
 * else 1 (or 0 when nothing can be ordered) — one bundle is also exactly what
 * an order-cart selection means. Without this an error would silently reset a
 * multi-package order to one, risking a wrong-quantity resubmit. */
const restoredPackageQuantity = (groupId: number, limit: number): number =>
  clampSavedQuantity(
    savedFormValue(packageQuantityFieldName(groupId)),
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
): number => {
  const saved = savedFormValue(childQuantityFieldName(parentId, childId));
  if (saved === "") return 0;
  return Math.max(0, Math.min(Number.parseInt(saved, 10) || 0, max));
};

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
const renderChildOption = (
  parent: ListingWithCount,
  child: TicketListing,
  childLimit: number,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
  showZero: boolean,
): string => {
  const parentId = parent.id;
  const { listing } = child;
  const bookable = childCanBeBooked(child);
  const selectName = childQuantityFieldName(parentId, listing.id);
  const priceHtml =
    listing.can_pay_more && bookable
      ? renderPayMoreInput(
          listing,
          childPriceFieldName(parentId, listing.id),
          undefined,
          false,
        )
      : "";
  const label = bookable
    ? `${escapeHtml(listing.name)} ${childPriceLabel(
        listing,
        parent,
        showZero,
      )}`.trim()
    : escapeHtml(t("public.ticket.child_unavailable", { name: listing.name }));
  const select = bookable
    ? `<select name="${selectName}" data-child-qty="${listing.id}"${childDateAttrs(
        parentId,
        child,
        childDatesById,
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
const renderSoleChildOption = (
  parent: ListingWithCount,
  child: TicketListing,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
  showZero: boolean,
): string => {
  const parentId = parent.id;
  const { listing } = child;
  const priceHtml = listing.can_pay_more
    ? renderPayMoreInput(
        listing,
        childPriceFieldName(parentId, listing.id),
        undefined,
        false,
      )
    : "";
  const visible = !listing.hidden;
  const namePart = visible ? escapeHtml(listing.name) : "";
  const pricePart = visible ? childPriceLabel(listing, parent, showZero) : "";
  const label = `${namePart} ${pricePart}`.trim();
  return `<p class="child-option child-sole" data-sole-parent="${parentId}" data-sole-child="${listing.id}"${childDateAttrs(
    parentId,
    child,
    childDatesById,
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
    .map((child) =>
      isSole(child)
        ? renderSoleChildOption(parent, child, ctx.childDatesById, showZero)
        : renderChildOption(
            parent,
            child,
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
            ctx.childDatesById,
            showZero,
          ),
    )
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

/** Render quantity selector for an listing row.
 *
 * An optional per-listing `prefill` pre-selects the quantity (clamped to the
 * available range) — used by multi-listing scenarios such as the order cart. */
const listingControls = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity: boolean,
  prefill: TicketPrefill | undefined,
  childCtx: ChildRenderCtx | undefined,
): { childBlock: string; priceHtml: string; quantityHtml: string } => {
  const { listing } = info;
  const maxPurchasable = childLimitedMax(info, childCtx);
  const fieldName = nodeQuantityFieldName(node)!;
  const priceFieldName = nodePriceFieldName(node)!;
  return {
    childBlock: childCtx ? renderChildBlock(info, childCtx) : "",
    priceHtml: listing.can_pay_more
      ? renderPayMoreInput(listing, priceFieldName, prefill?.customPriceMinor)
      : "",
    quantityHtml: hideQuantity
      ? `<input type="hidden" name="${fieldName}" value="1" />`
      : `<select name="${fieldName}">${quantityOptions(
          maxPurchasable,
          restoredQuantity(listing.id, prefill, maxPurchasable),
        )}</select>`,
  };
};

const renderListingRow = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity = false,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const { listing, isSoldOut, isClosed } = info;
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

  const { childBlock, priceHtml, quantityHtml } = listingControls(
    info,
    node,
    hideQuantity,
    prefill,
    childCtx,
  );

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(listing.name)}${quantityHtml}</label>
      ${renderListingDescription(listing.description)}
      ${priceHtml}
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
      ${childCtx ? renderChildBlock(info, childCtx) : ""}
    </div>
  `;

/** One package's booking controls: its "number of packages" selector, then each
 * member row (each showing its fixed quantity) — unless the package hides its
 * listings from buyers, in which case only the selector shows. `limit` is the
 * most bundles of this package the buyer can book; `childCtxFor` says whether
 * a member's row carries the parent's child selector (a parent shared by two
 * bundles renders it once — see {@link buildPageListingRows}). */
const renderPackageControls = (
  pkg: PagePackage,
  members: TicketListing[],
  limit: number,
  childCtxFor: (memberListingId: number) => ChildRenderCtx | undefined,
): string => {
  // Every member as `id:fixedQty`, so the client knows which listing-scoped
  // questions to show/require once this package is selected — even when
  // members are hidden and render no rows of their own — and how many units
  // each chosen bundle books of a member (the child scripts total a parent's
  // units across every path that books it).
  const memberIds = members
    .map((e) => `${e.listing.id}:${pkg.quantities.get(e.listing.id) ?? 1}`)
    .join(" ");
  const selector = `<label>${t(
    "public.package.quantity",
  )}<select name="${packageQuantityFieldName(
    pkg.groupId,
  )}" data-package-members="${memberIds}">${quantityOptions(
    limit,
    restoredPackageQuantity(pkg.groupId, limit),
  )}</select></label>`;
  const memberRows = pkg.hideListings
    ? ""
    : members
        .map((e) =>
          renderPackageMemberRow(
            e,
            pkg.quantities.get(e.listing.id) ?? 1,
            childCtxFor(e.listing.id),
          ),
        )
        .join("");
  return selector + memberRows;
};

/** One package as a titled section of a page selling several things: the
 * package's name (and description) above its controls, or a dimmed sold-out
 * card when no whole bundle fits any more — the page stays usable for the
 * other items, matching the order gallery's sold-out cards. */
const renderPackageSection = (
  pkg: PagePackage,
  members: TicketListing[],
  limit: number,
  childCtxFor: (memberListingId: number) => ChildRenderCtx | undefined,
): string => {
  const heading = `<legend>${escapeHtml(pkg.name)}</legend>`;
  const body =
    limit < 1
      ? `<span class="sold-out-label">${t("public.sold_out")}</span>`
      : renderListingDescription(pkg.description) +
        renderPackageControls(pkg, members, limit, childCtxFor);
  return `<fieldset class="ticket-package${
    limit < 1 ? " sold-out" : ""
  }" data-package-section="${pkg.groupId}">${heading}${body}</fieldset>`;
};

/** Render controls for a single listing: quantity input + pay-more (no listing name/image/description). */
const renderSingleListingControls = (
  info: TicketListing,
  node: BookingNode,
  hideQuantity: boolean,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const { childBlock, priceHtml, quantityHtml } = listingControls(
    info,
    node,
    hideQuantity,
    prefill,
    childCtx,
  );
  const labelledQuantity = hideQuantity
    ? quantityHtml
    : `<label>${t("public.ticket.number_of_tickets")}${quantityHtml}</label>`;
  return `${labelledQuantity}${priceHtml}${childBlock}`;
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
  /** The header entity's images, shown as the shared CSS gallery above the
   * form (empty ⇒ falls back to the single header image). */
  galleryImages?: readonly Image[];
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
  /** The package bundles sold on this page, in page order. Each package's
   * members render under its own count selector instead of per-member
   * quantities; listings outside every package keep their own controls. */
  packages?: PagePackage[];
  /** Remaining spots for package member groups. */
  packageGroupRemainingByGroupId?: ReadonlyMap<number, number>;
  packageMemberGroupIds?: ReadonlyMap<number, number[]>;
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
  galleryImages,
  singleListing,
  pastDays,
}: {
  headerName: string;
  headerDescription: string | null | undefined;
  headerImage: ItemImageProjection | null;
  galleryImages: readonly Image[];
  singleListing: ListingWithCount | null;
  pastDays: number | null;
}): JSX.Element => (
  <>
    {/* The full CSS gallery when the header entity has images; otherwise the
        single header-image projection (a listing whose only picture is its
        stored `image_url` with no image_uses rows). */}
    {galleryImages.length > 0 ? (
      <PublicImageGallery images={galleryImages} />
    ) : (
      headerImage && <Raw html={renderListingImage(headerImage)} />
    )}
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
  </div>
);

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
  hasCustomisable: boolean;
  dayCounts: number[];
  dayCountPriceFor?: ((days: number) => number | null) | undefined;
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
}): JSX.Element => {
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

/** The day-count option pricer for a page: a page that IS one customisable
 * package prices each option as the whole bundle's total; every other page
 * keeps the pricer {@link dayConfig} resolved (the single listing's own day
 * prices, or none). */
const resolveDayCountPriceFor = (
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
const dayConfig = (
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
  // A package books every member, so each parent member's child union
  // constrains the bundle's spans; other pages constrain only the
  // single-listing-parent case.
  dayCounts:
    hasPackages && childrenByParentId
      ? packageDayCountsChildrenSupport(listings, childrenByParentId)
      : keepParentDayCountsChildrenSupport(
          listings,
          dayCountsEveryListingSupports(listings),
          childrenByParentId,
        ),
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
const splitChildQuestions = (
  listings: TicketListing[],
  questions: QuestionWithAnswers[],
  questionListingMap: QuestionListingMap | undefined,
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
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

/** Whether a listing is paid through ANY path this page sells it. Each package
 * that bundles it prices it by that package's own rule: a flat override
 * REPLACES the base price for that path (an explicit free 0 makes the path
 * free), a positive per-day override makes a customisable member paid, and
 * without either the listing's own pricing decides. A listing nobody bundles —
 * or one ALSO sold on its own row beside its bundles — charges its own price
 * on the standalone path, whatever any bundle says. One cheap path never hides
 * a charging one: the buyer can always choose the paid path, so the provider
 * fields must render. */
const paidInContext = (
  info: TicketListing,
  packages: readonly PagePackage[],
  standaloneRowIds: ReadonlySet<number>,
): boolean => {
  const id = info.listing.id;
  const owners = packages.filter((pkg) => pkg.memberListingIds.includes(id));
  const paidVia = (pkg: PagePackage): boolean => {
    const override = pkg.prices.get(id);
    if (override !== undefined) return override > 0;
    const dayOverrides = pkg.dayPrices.get(id);
    if (dayOverrides && [...dayOverrides.values()].some((p) => p > 0)) {
      return true;
    }
    return isPaidListing(info.listing);
  };
  const sellsStandalone = owners.length === 0 || standaloneRowIds.has(id);
  return (
    owners.some(paidVia) || (sellsStandalone && isPaidListing(info.listing))
  );
};

/** Whether the page itself (its listings or add-ons, NOT possible children) is
 * paid — so its provider-imposed email renders required. */
const pagePaid = (
  listings: TicketListing[],
  addOns: AddOnOption[] | undefined,
  packages: readonly PagePackage[],
  standaloneRowIds: ReadonlySet<number>,
): boolean =>
  listings.some((e) => paidInContext(e, packages, standaloneRowIds)) ||
  (addOns?.some((addOn) => addOn.requiresPayment) ?? false);

/** Whether the contact-field set must include a paid order's provider-imposed
 * fields: any page listing, possible child, or add-on is paid. A free parent with
 * a paid child still needs the email field present (non-required, enforced
 * server-side when the folded order is actually paid). */
const pageOrChildPaid = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  addOns: AddOnOption[] | undefined,
  packages: readonly PagePackage[],
  standaloneRowIds: ReadonlySet<number>,
): boolean => {
  const children = childrenByParentId
    ? [...childrenByParentId.values()].flat()
    : [];
  return (
    pagePaid(listings, addOns, packages, standaloneRowIds) ||
    children.some((e) => isPaidListing(e.listing))
  );
};

/** Render the per-listing rows (with their child blocks). A single-listing page
 * shows just the controls (details live in the header); multi-listing pages
 * show a compact row each. Both honour per-listing quantity pre-fills.
 * `childCtxFor` suppresses the child block on a row whose listing also has a
 * package member row on the page (that row carries the one child selector). */
const buildListingRows = (
  listings: TicketListing[],
  nodeByListingId: ReadonlyMap<number, BookingNode>,
  isSingleListing: boolean,
  hideQuantity: boolean,
  prefill: BookingPrefill | undefined,
  childCtxFor: (info: TicketListing) => ChildRenderCtx | undefined,
): string =>
  isSingleListing
    ? renderSingleListingControls(
        listings[0]!,
        nodeByListingId.get(listings[0]!.listing.id)!,
        hideQuantity,
        prefill?.listings.get(listings[0]!.listing.id),
        childCtxFor(listings[0]!),
      )
    : listings
        .map((e) =>
          renderListingRow(
            e,
            nodeByListingId.get(e.listing.id)!,
            hideQuantity,
            prefill?.listings.get(e.listing.id),
            childCtxFor(e),
          ),
        )
        .join("");

/** Build the page's listing area. A page that IS one package (every listing a
 * member, nothing sold beside it) shows that package's count selector plus
 * read-only member rows, as before. A page selling several things shows each
 * package as a titled section, then the per-listing controls for every
 * standalone row — including a member the cart ALSO added on its own, whose
 * child selector stays on its member row so it renders exactly once. */
const buildPageListingRows = (opts: {
  singlePackagePage: boolean;
  listings: TicketListing[];
  packages: PagePackage[];
  packageLimits: ReadonlyMap<number, number>;
  standaloneRowIds: ReadonlySet<number>;
  nodeByListingId: ReadonlyMap<number, BookingNode>;
  isSingleListing: boolean;
  hideQuantity: boolean;
  prefill?: BookingPrefill | undefined;
  childCtx?: ChildRenderCtx | undefined;
}): string => {
  const membersOf = (pkg: PagePackage): TicketListing[] => {
    const memberIds = new Set(pkg.memberListingIds);
    return opts.listings.filter((info) => memberIds.has(info.listing.id));
  };
  // One child selector per parent across ALL package sections: the first
  // section selling a parent claims its child block, and an overlapping
  // bundle's later row suppresses it — duplicate same-named child fields
  // would silently drop the buyer's chosen mix.
  const claimedChildParents = new Set<number>();
  const claimChildCtx = (
    memberListingId: number,
  ): ChildRenderCtx | undefined => {
    if (claimedChildParents.has(memberListingId)) return undefined;
    claimedChildParents.add(memberListingId);
    return opts.childCtx;
  };
  if (opts.singlePackagePage) {
    const pkg = opts.packages[0]!;
    // packageLimits carries every page package by construction.
    return renderPackageControls(
      pkg,
      membersOf(pkg),
      opts.packageLimits.get(pkg.groupId)!,
      claimChildCtx,
    );
  }
  const packageSections = opts.packages
    .map((pkg) =>
      renderPackageSection(
        pkg,
        membersOf(pkg),
        opts.packageLimits.get(pkg.groupId)!,
        claimChildCtx,
      ),
    )
    .join("");
  const memberIds = packageMemberIds(opts.packages);
  const standalone = opts.listings.filter((info) =>
    opts.standaloneRowIds.has(info.listing.id),
  );
  // A cart of overlapping bundles may have NO standalone rows at all (every
  // listing books through a package) — the sections are the whole page then.
  if (standalone.length === 0) return packageSections;
  return (
    packageSections +
    buildListingRows(
      standalone,
      opts.nodeByListingId,
      // The bare single-listing controls (no name row — details live in the
      // header) only fit a page with nothing else on it. Beside a package
      // section, even a lone standalone row needs its named row, or the buyer
      // sees an unlabelled quantity selector under the bundle.
      opts.isSingleListing && opts.packages.length === 0,
      opts.hideQuantity,
      opts.prefill,
      (info) => (memberIds.has(info.listing.id) ? undefined : opts.childCtx),
    )
  );
};

/** Each page package's bundle limit, plus whether the whole page should show as
 * sold out (nothing standalone left AND no package bookable). */
const packagePageAvailability = (
  packages: PagePackage[],
  tree: BookingTree,
  listings: TicketListing[],
  standaloneRowIds: ReadonlySet<number>,
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
): { packageLimits: Map<number, number>; soldOut: boolean } => {
  const page = packageLimitInfo(
    listings,
    childrenByParentId,
    groupRemainingByGroupId,
    groupIdsByListingId,
  );
  const packageLimits = new Map(
    packages.map((pkg) => [
      pkg.groupId,
      pagePackageBundleLimit(tree, pkg, page),
    ]),
  );
  const standaloneUnavailable = listings
    .filter((info) => standaloneRowIds.has(info.listing.id))
    .every((e) => e.isSoldOut || e.isClosed);
  const packagesUnavailable = [...packageLimits.values()].every(
    (limit) => limit === 0,
  );
  return {
    packageLimits,
    // Sold out only when every standalone row AND every bundle is dead (a
    // bundle with an unavailable member already reads limit 0; a package-less
    // page has no bundles, leaving just its listings' own availability).
    soldOut: standaloneUnavailable && packagesUnavailable,
  };
};

/** The lone listing whose rich details (image/date/location) head the page and
 * feed its OpenGraph tags, or null for a multi-listing page OR a hidden package
 * — a hidden package with one active member must not expose that member here. */
const headerListing = (
  listings: TicketListing[],
  packages: PagePackage[],
): ListingWithCount | null =>
  listings.length === 1 && !packages.some((pkg) => pkg.hideListings)
    ? listings[0]!.listing
    : null;

/** Build the page's booking tree and the row-shaping facts read off it: which
 * listings get their own quantity row (those with a standalone BUYER_CHOICE
 * node), which node each row reads its field names from (a dual-path listing
 * resolves to its standalone node, not its member node), and whether the page
 * IS one package (every listing a member, nothing sold beside it — the classic
 * package-page layout). */
const buildPageTree = (
  input: BuildTreeInput,
  packageCount: number,
): {
  tree: BookingTree;
  standaloneRowIds: Set<number>;
  nodeByListingId: Map<number, BookingNode>;
  singlePackagePage: boolean;
} => {
  const tree = buildBookingTree(input);
  const standaloneRowIds = new Set(
    tree.nodes
      .filter((node) => node.quantityRule.kind === "BUYER_CHOICE")
      .map((node) => node.listingId),
  );
  const nodeByListingId = new Map<number, BookingNode>();
  for (const node of tree.nodes) {
    if (
      !nodeByListingId.has(node.listingId) ||
      node.quantityRule.kind === "BUYER_CHOICE"
    ) {
      nodeByListingId.set(node.listingId, node);
    }
  }
  return {
    nodeByListingId,
    singlePackagePage: packageCount === 1 && standaloneRowIds.size === 0,
    standaloneRowIds,
    tree,
  };
};

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
  galleryImages = [],
  prefill,
  actionUrl,
  addOns,
  promoCodesEnabled,
  childrenByParentId,
  childDatesById,
  groupRemainingByGroupId = new Map(),
  groupIdsByListingId = new Map(),
  packages = [],
  packageGroupRemainingByGroupId = new Map(),
  packageMemberGroupIds = new Map(),
}: TicketPageOptions): string => {
  // The canonical booking tree drives node identity + the stable form field
  // names (via nodeQuantityFieldName/nodePriceFieldName): one node per
  // bookable path, so a member the cart also added by its own slug gets a
  // standalone node (and row) beside its package.
  const treeInput: BuildTreeInput = {
    childrenByParentId,
    listings,
    packages,
    slugs,
    standaloneListingIds: explicitStandaloneIds(
      listings.map((info) => info.listing),
      packages,
      slugs,
    ),
  };
  const { tree, standaloneRowIds, nodeByListingId, singlePackagePage } =
    buildPageTree(treeInput, packages.length);
  const inIframe = getIframeMode();
  const { packageLimits, soldOut: allUnavailable } = packagePageAvailability(
    packages,
    tree,
    listings,
    standaloneRowIds,
    childrenByParentId,
    packageGroupRemainingByGroupId,
    packageMemberGroupIds,
  );
  const allClosed = listings.every((e) => e.isClosed);
  const fields: Field[] = buildContactFields(
    listings,
    childrenByParentId,
    pagePaid(listings, addOns, packages, standaloneRowIds),
    pageOrChildPaid(
      listings,
      childrenByParentId,
      addOns,
      packages,
      standaloneRowIds,
    ),
  );
  const hasDaily = listings.some((e) => e.listing.listing_type === "daily");

  const singleListing = headerListing(listings, packages);
  const isSingleListing = singleListing !== null;
  const pastDays = singleListing?.date ? daysAgo(singleListing.date) : null;

  const dayCfg = dayConfig(
    listings,
    singleListing,
    childrenByParentId,
    packages.length > 0,
  );
  const { hasCustomisable, dayCounts, dateDurationDays } = dayCfg;
  const dayCountPriceFor = resolveDayCountPriceFor(
    singlePackagePage,
    tree,
    bookableChildIds(childrenByParentId),
    dayCfg,
  );

  const availableListings = listings.filter((e) => !e.isSoldOut && !e.isClosed);
  const hideQuantity =
    packages.length === 0 &&
    availableListings.length === 1 &&
    availableListings[0]?.maxPurchasable === 1;

  const { pageQuestions, childCtx } = splitChildQuestions(
    listings,
    questions ?? [],
    questionListingMap,
    childrenByParentId,
    groupRemainingByGroupId,
    childDatesById ?? new Map(),
    groupIdsByListingId,
  );

  // A package page shows one "number of packages" selector plus read-only member
  // rows (each ×its fixed quantity); a mixed page shows each package as a titled
  // section above the per-listing controls.
  const listingRows = buildPageListingRows({
    childCtx,
    hideQuantity,
    isSingleListing,
    listings,
    nodeByListingId,
    packageLimits,
    packages,
    prefill,
    singlePackagePage,
    standaloneRowIds,
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
          galleryImages={galleryImages}
          headerDescription={headerDescription}
          headerImage={headerImage}
          headerName={headerName}
          pastDays={pastDays}
          singleListing={singleListing}
        />
      )}
      <Flash error={error} />

      {allUnavailable || isReadOnly() ? (
        <ErrorNote>{unavailableMessage(allClosed, isSingleListing)}</ErrorNote>
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
          isPackage={singlePackagePage}
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
