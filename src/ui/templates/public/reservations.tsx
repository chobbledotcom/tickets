import { filter, mapNotNullish, pipe } from "#fp";
import { t } from "#i18n";
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
import { renderMarkdown } from "#shared/markdown.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import {
  availableDayCounts,
  dayPriceFor,
  isPaidListing,
  type ListingFields,
  type ListingWithCount,
  normalizeDurationDays,
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupRemaining,
} from "#shared/types.ts";
import { getTicketFields, mergeListingFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import {
  type ChildSpanDates,
  childActive,
  childDateKey,
  childOpen,
  childSelectableIgnoringSpan,
  childStandardInStock,
  constrainOptionsByChildUnion,
  encodeChildSpanDates,
  renderListingImage,
  resolveInheritedDuration,
  selectableChild,
  type TicketListing,
} from "./shared.tsx";
/** OpenGraph meta tags for a public listing page. */
export const buildOgTags = (
  listing: {
    name: string;
    description: string;
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

/**
 * Day-count options shared across every "customisable days" listing on the page:
 * the intersection of each listing's offered counts, so one selector can drive the
 * whole booking (groups enforce a uniform setting, but ad-hoc multi-listing URLs
 * may still mix). Empty when no listing is customisable.
 */
export const sharedDayCounts = (listings: TicketListing[]): number[] => {
  const customisable = listings.filter((e) => e.listing.customisable_days);
  if (customisable.length === 0) return [];
  const sets = customisable.map((e) => new Set(availableDayCounts(e.listing)));
  const [first, ...rest] = sets;
  return [...first!]
    .filter((n) => rest.every((s) => s.has(n)))
    .sort((a, b) => a - b);
};

/** The day-count spans a required child supports, or null when it imposes no
 * span constraint (Codex 1030). A CUSTOMISABLE child supports its
 * {@link availableDayCounts}; a FIXED DAILY child supports only its own
 * `duration_days`; a STANDARD non-daily child folds duration-1 and is priced by
 * the parent's resolved span, so it constrains nothing ("any"). */
const childSupportedSpans = (child: TicketListing): number[] | null => {
  if (child.listing.customisable_days) return availableDayCounts(child.listing);
  if (child.listing.listing_type === "daily") {
    return [normalizeDurationDays(child.listing.duration_days)];
  }
  return null;
};

/**
 * Constrain a customisable parent's day-count options to the spans at least one
 * of its SELECTABLE required children can serve (Codex 1030/158):
 * `parentDayCounts ∩ (UNION of the selectable children's supported spans)`.
 * Without this, a customisable parent offering {1,2} days whose only child prices
 * only 2 days still shows the 1-day option, which the submit-side fold rejects.
 *
 * Children are first filtered by the date-independent disqualifiers
 * ({@link childSelectableIgnoringSpan}) so an inactive / closed / sold-out child
 * contributes NOTHING (Codex 158): an inactive STANDARD child returns `null` from
 * {@link childSupportedSpans} ("any span") and would otherwise preserve every
 * parent span, and an inactive 1-day child would keep a 1-day option the active
 * 2-day child can't serve. After filtering, a child imposing no span constraint
 * ("any") still keeps every parent span.
 *
 * Scope mirrors the date rule (`constrainDatesByChildUnion` in ticket-payment.ts):
 * only a SINGLE-listing page that is itself a parent is constrained, since on a
 * multi-listing / group page one selector is shared and an unselected parent's
 * child spans must not remove a span a different page listing needs — the spec
 * defers that to the per-selected-parent JS constraint plus the submit fold.
 */
const constrainDayCountsByChildUnion = (
  listings: TicketListing[],
  parentDayCounts: number[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
): number[] => {
  if (!childrenByParentId || listings.length !== 1) return parentDayCounts;
  const all = childrenByParentId.get(listings[0]!.listing.id);
  if (!all || all.length === 0) return parentDayCounts;
  return constrainOptionsByChildUnion(
    parentDayCounts,
    all,
    childSelectableIgnoringSpan,
    // "any" child (no span constraint) keeps every parent span; otherwise its own.
    (child) => childSupportedSpans(child) ?? parentDayCounts,
  );
};

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
 * child's price (invariant I9). */
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
    )}" pattern="\\d+(\\.\\d{1,2})?" title="${escapeHtml(
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
 * enforces requiredness only for the selected child — invariant I9). `listingIds`
 * (when present) lets the visibility script show/hide. */
const renderQuestion = (
  q: QuestionWithAnswers,
  required: boolean,
  listingIds?: string,
): JSX.Element => {
  const answered = savedFormValue(`question_${q.id}`);
  const options = q.answers.filter((a) => a.active);
  // A select is a single control, so a plain <label> names it like the text fields
  // do; radios are a set of controls, so they need a <fieldset>/<legend> to label
  // the group. Both carry .custom-question (plus any data-listing-ids) so the
  // visibility script can show/hide them.
  if (q.display_type === "free_text") {
    return (
      <label class="custom-question" data-listing-ids={listingIds}>
        {q.text}
        <input
          maxlength={MAX_TEXTAREA_LENGTH}
          name={`question_${q.id}`}
          required={required}
          type="text"
          value={answered}
        />
      </label>
    );
  }
  if (q.display_type === "select") {
    return (
      <label class="custom-question" data-listing-ids={listingIds}>
        {q.text}
        <select name={`question_${q.id}`} required={required}>
          <option value="">
            {t("public.ticket.select_answer_placeholder")}
          </option>
          {options.map((a) => (
            <option selected={answered === String(a.id)} value={String(a.id)}>
              {a.text}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <fieldset class="custom-question" data-listing-ids={listingIds}>
      <legend>{q.text}</legend>
      {options.map((a) => (
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
      ))}
    </fieldset>
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
    savedFormValue(`quantity_${listingId}`),
    maxPurchasable,
    resolveQuantity(prefill, maxPurchasable),
  );

/** The package count to pre-select: the value the buyer just submitted (restored
 * when a validation error re-renders the page) clamped to the cap, else 1 (or 0
 * when nothing can be ordered). Without this an error would silently reset a
 * multi-package order to one, risking a wrong-quantity resubmit. */
const restoredPackageQuantity = (cap: number): number =>
  clampSavedQuantity(savedFormValue("package_quantity"), cap, Math.min(1, cap));

/**
 * Per-parent child rendering inputs threaded down to the listing rows: the page's
 * children grouped by parent, the page questions and their listing map (to render
 * each child's questions), and a shared `rendered` set so a question shared by
 * sibling children (or by the parent) renders exactly once (invariant I9). Empty
 * `children` means the page has no parents and nothing extra renders.
 */
export type ChildRenderCtx = {
  children: Map<number, TicketListing[]>;
  /** Each DAILY child's holiday-aware serveable start dates PER selectable parent
   * span ({@link ChildSpanDates}, Fix 4), keyed by the (parent, child) PAIR
   * ({@link childDateKey}) so a child required by two parents carries each parent's
   * own dates; emitted as `data-child-dates` so the client compatibility script can
   * disable a child the selected date/day-count can't serve (Codex 430, Fix 1).
   * Non-daily children are omitted (no date constraint). */
  childDatesById: ReadonlyMap<string, ChildSpanDates>;
  /** Each GROUP id → its remaining spots (uncapped groups omitted), for the
   * combined parent+child demand clamp against the SPECIFIC shared group
   * (invariant I7, Codex #2/#3); empty when no group caps apply. */
  groupRemainingByGroupId: ReadonlyMap<number, number>;
  /** Each listing id → the ids of the groups it belongs to, so the
   * shared-group/co-grouped checks resolve the group a parent and child share.
   * Empty/absent entries mean ungrouped. */
  groupIdsByListingId: ReadonlyMap<number, number[]>;
  questions: QuestionWithAnswers[];
  questionListingMap: QuestionListingMap | undefined;
  rendered: Set<number>;
};

/** Whether a child is currently bookable (its quantity controls render enabled):
 * active, not registration-closed, and — for a STANDARD child — not sold out. The
 * server fold rejects an inactive child, so an inactive option must never render
 * enabled or auto-checked: it would always fail at submit. Unavailable children
 * render disabled (parents.md, invariant I6).
 *
 * Fix 3: a DAILY child must NOT be disqualified by the date-LESS `isSoldOut`
 * aggregate ({@link childStandardInStock} exempts daily) — that flag reads true
 * once the child is full on ANY single date, so the strict check wrongly disabled
 * a daily child (and clamped the parent to 0) on EVERY date even when other dates
 * still have capacity. A daily child's per-date capacity is enforced by the
 * date-aware submit fold / `checkBatchAvailability`. Standard children keep the
 * date-less sold-out check. */
const childBookable: (child: TicketListing) => boolean = selectableChild([
  childActive,
  childOpen,
  childStandardInStock,
]);

/**
 * A bookable child's date-LESS own capacity for the render cap. A STANDARD child's
 * `maxPurchasable` is cumulative and authoritative. A DAILY child's date-less
 * `maxPurchasable` is meaningless at render — it reads 0 once the child is full on
 * ANY single date — so it must NOT clamp the parent's quantity (Fix 3); its real
 * per-date capacity is enforced by the date-aware submit fold once a date is chosen.
 * So a daily child contributes the parent's own max (no date-less ceiling),
 * mirroring how {@link childBookable} exempts it from the sold-out disqualifier. */
const childOwnRenderCap = (
  parent: TicketListing,
  child: TicketListing,
): number =>
  child.listing.listing_type === "daily"
    ? parent.maxPurchasable
    : child.maxPurchasable;

/**
 * A single bookable child's contribution to its parent's quantity ceiling, in
 * whole parent+child orders (Fix 3, invariant I7). Each order consumes one parent
 * unit plus one child unit. When the parent and child share a **capped group**
 * those two units land in the *same* pool, so the cap is
 * `floor(sharedRemaining / PARENT_CHILD_GROUP_UNITS)` — e.g. 3 shared spots offer
 * only 1 order (2 consumed), 4 offer 2. In different or uncapped groups they draw
 * from separate pools, so the child's own render cap ({@link childOwnRenderCap})
 * stands. `checkBatchAvailability` rejects (never clamps) anything above this, so
 * the selector must not offer a quantity it would reject.
 *
 * Fix 5: even in a shared capped group the cap can never exceed the child's OWN
 * capacity. A 10-spot shared group with a 1-capacity child mathematically fits
 * `floor(10 / 2) = 5` orders, but the child can only fulfil 1 — `foldChild` rejects
 * the rest. So the shared-group cap is `min(floor(sharedRemaining / units), child
 * own cap)`. (A daily child is never in a date-less group aggregate, so it only
 * ever hits the separate-pool branch.)
 */
const childOrderCap = (
  parent: TicketListing,
  child: TicketListing,
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
): number => {
  const shared = sharedGroupRemaining(
    groupIdsByListingId.get(parent.listing.id) ?? [],
    groupIdsByListingId.get(child.listing.id) ?? [],
    groupRemainingByGroupId,
  );
  return shared === undefined
    ? childOwnRenderCap(parent, child)
    : Math.min(
        Math.floor(shared / PARENT_CHILD_GROUP_UNITS),
        childOwnRenderCap(parent, child),
      );
};

/** A capped child-only group's contribution to the combined cap (Fix 3): the
 * children in ONE capped group the parent is NOT part of all draw from a single
 * pool of `remaining` spots, and under per-unit selection each child unit consumes
 * ONE spot, so the whole cohort contributes a SINGLE `min(remaining, Σ child own
 * caps)` term — counted once, not per child. Summing each child individually
 * over-offers (two children in a 1-spot group each report cap 1, but 1-of-each
 * consumes 2 and `checkBatchAvailability` rejects). The `Σ own caps` clamp mirrors
 * the shared-with-parent cohort's Fix 5 clamp: the buyer can't put more units than
 * the children can fulfil even when the pool has room. */
const cappedGroupCohortCap = (remaining: number, ownCapSum: number): number =>
  Math.min(remaining, ownCapSum);

/**
 * The combined child-side capacity available to a parent across ALL its bookable
 * children, in whole parent+child orders (Fix 2, invariant I7). Under per-unit
 * distribution the buyer spreads Q child units across the children in any mix, so
 * separate-pool children COMBINE: two children each capped at 1 together serve a
 * parent quantity of 2 (1 + 1). So the contribution is the SUM of each child's
 * order cap ({@link childOrderCap}) — NOT the max of a single child.
 *
 * Children sharing ONE capped group WITH THE PARENT must not be over-counted: the
 * parent + every co-grouped child draw from the same pool, and each combined order
 * consumes {@link PARENT_CHILD_GROUP_UNITS} spots regardless of how many such
 * children exist, so the whole cohort contributes a SINGLE `floor(sharedRemaining /
 * units)` term. {@link sharedGroupRemaining} returns the shared pool's remaining
 * (same value for every co-grouped child) or `undefined` for a separate pool.
 *
 * Fix 3: children sharing ONE capped group NOT containing the parent must ALSO
 * collapse to a single term — the parent isn't in their pool so each child unit
 * consumes one spot, and summing each over-offers (two children in a 1-spot group
 * render parent max 2, yet 1-of-each consumes 2 and the batch check rejects). So
 * separate-pool children are bucketed by their capped `group_id` and each bucket
 * clamped ONCE by its remaining ({@link cappedGroupCohortCap}); ungrouped/uncapped
 * children still add their own cap individually.
 *
 * Fix 5: every cohort term is additionally clamped by its children's OWN combined
 * capacity (`Σ child own cap`) — the buyer can only put as many units on a cohort
 * as its children can fulfil, even when the pool would allow more (a 10-spot group
 * whose single co-grouped child caps at 1 contributes 1, which the fold would
 * otherwise reject).
 */
const childCombinedCap = (
  parent: TicketListing,
  bookable: TicketListing[],
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
): number => {
  const parentGroupIds = groupIdsByListingId.get(parent.listing.id) ?? [];
  let sharedCohortRemaining: number | undefined;
  let sharedCohortChildMax = 0;
  let separateSum = 0;
  // Separate (not-with-parent) CAPPED groups, bucketed by the SPECIFIC capped
  // group id the children share — NOT the child's whole group set (Codex #2).
  // Two children both in capped group A but with different OTHER memberships
  // would land in different full-set buckets and each offer cap 1, over-offering
  // 2 where the shared pool fits 1; keying by the tightest capped group id they
  // share collapses them into one term. A child in several separate capped groups
  // is assigned to its tightest (least-remaining) one; the submit-time
  // checkBatchAvailability is the authoritative per-group gate for the rest.
  const cappedGroups = new Map<number, { remaining: number; ownCap: number }>();
  for (const child of bookable) {
    const ownCap = childOwnRenderCap(parent, child);
    const childGroupIds = groupIdsByListingId.get(child.listing.id) ?? [];
    const shared = sharedGroupRemaining(
      parentGroupIds,
      childGroupIds,
      groupRemainingByGroupId,
    );
    if (shared !== undefined) {
      // Co-grouped with the PARENT: one shared pool. The tightest shared group's
      // remaining stands for every co-grouped child, so record it once; the
      // cohort's combined order cap is added below, not per child. (Daily children
      // never reach this branch — no date-less group entry.)
      sharedCohortRemaining =
        sharedCohortRemaining === undefined
          ? shared
          : Math.min(sharedCohortRemaining, shared);
      sharedCohortChildMax += ownCap;
      continue;
    }
    // The child's capped groups the parent is NOT in, tightest first.
    const separateCapped = childGroupIds
      .filter((g) => groupRemainingByGroupId.has(g))
      .map((g) => ({ groupId: g, remaining: groupRemainingByGroupId.get(g)! }))
      .sort((a, b) => a.remaining - b.remaining);
    if (separateCapped.length === 0) {
      // Ungrouped or uncapped: a private pool, so it adds its own cap directly.
      separateSum += ownCap;
      continue;
    }
    // A capped child-only group the parent is NOT in (Fix 3, Codex #2): bucket by
    // the tightest shared capped group id so several children drawing on it
    // collapse to one term clamped by that group's remaining.
    const { groupId, remaining } = separateCapped[0]!;
    const bucket = cappedGroups.get(groupId) ?? { ownCap: 0, remaining };
    bucket.ownCap += ownCap;
    cappedGroups.set(groupId, bucket);
  }
  const sharedCohortCap =
    sharedCohortRemaining === undefined
      ? 0
      : Math.min(
          Math.floor(sharedCohortRemaining / PARENT_CHILD_GROUP_UNITS),
          sharedCohortChildMax,
        );
  let cappedGroupsCap = 0;
  for (const { remaining, ownCap } of cappedGroups.values()) {
    cappedGroupsCap += cappedGroupCohortCap(remaining, ownCap);
  }
  return separateSum + sharedCohortCap + cappedGroupsCap;
};

/**
 * The quantity cap to offer for a parent's own selector, clamped to its required
 * children's COMBINED capacity (Codex 485/565, Fix 2): `min(parentMaxPurchasable,
 * Σ combinable child capacities)` — the sum across separate-pool bookable children
 * plus a single shared-group cohort term (see {@link childCombinedCap}). Two
 * separate-pool children each capped at 1 thus offer a parent quantity of 2 (1 +
 * 1), which the fold accepts; the old per-child MAX wrongly blocked it at 1. A
 * parent with no bookable child is handled upstream (sold out, invariant I6); here
 * that yields a 0 cap.
 */
const childCappedMax = (
  info: TicketListing,
  childCtx: ChildRenderCtx | undefined,
): number => {
  const children = childCtx?.children.get(info.listing.id);
  if (!childCtx || !children || children.length === 0) {
    return info.maxPurchasable;
  }
  const bookable = children.filter(childBookable);
  const childCap = childCombinedCap(
    info,
    bookable,
    childCtx.groupRemainingByGroupId,
    childCtx.groupIdsByListingId,
  );
  return Math.min(info.maxPurchasable, childCap);
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
 * {@link resolveInheritedDuration}: customisable → null, standard → 1. */
const parentRenderDuration = (parent: ListingWithCount): number | null =>
  resolveInheritedDuration<number | null>(parent, null, 1);

/** The "from" price for a customisable child under a customisable parent: the
 * minimum child day price over the spans the parent can ACTUALLY offer (parent's
 * selectable counts ∩ child's priced counts). Using the child's own lowest span
 * ignores the parent's range, so a parent offering only {3} days with a child
 * priced {1:£10, 3:£25} would advertise "from £10" while checkout (inheriting the
 * 3-day span) charges £25 (Codex 398). Returns null when the spans don't intersect
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
  const saved = savedFormValue(`child_qty_${parentId}_${childId}`);
  if (saved === "") return 0;
  return Math.max(0, Math.min(Number.parseInt(saved, 10) || 0, max));
};

/** The date/span compatibility attributes a child qty/sole control carries so the
 * client compatibility script (Codex 430) can disable it (and, for a sole child,
 * flag its parent — Fix 1) when the selected date/day-count can't be served:
 * `data-child-dates` (a DAILY child's serveable starts per selectable span, from
 * the holiday-aware {@link ChildRenderCtx.childDatesById}, encoded
 * `span:d,d|span:d,d` — Fix 4) and `data-child-spans` (a CUSTOMISABLE/fixed-DAILY
 * child's supported day counts, from {@link childSupportedSpans}). A child with no
 * date/span constraint (e.g. a standard child) emits NOTHING — always compatible.
 *
 * Serveable dates are keyed by the (parent, child) PAIR ({@link childDateKey}, Fix
 * 4) so the same daily child under two parents with different calendars carries
 * each parent's own dates. */
const childCompatAttrs = (
  parentId: number,
  child: TicketListing,
  childDatesById: ReadonlyMap<string, ChildSpanDates>,
): string => {
  const attrs: string[] = [];
  const dates = childDatesById.get(childDateKey(parentId, child.listing.id));
  if (dates !== undefined) {
    attrs.push(
      ` data-child-dates="${escapeHtml(encodeChildSpanDates(dates))}"`,
    );
  }
  const spans = childSupportedSpans(child);
  if (spans !== null) {
    attrs.push(` data-child-spans="${escapeHtml(spans.join(","))}"`);
  }
  return attrs.join("");
};

/** Render one child as a per-unit quantity row: a `child_qty_<parentId>_<childId>`
 * select over `0..childCap`, plus — for a bookable pay-more child — its
 * non-required price input. A sold-out/closed/inactive child renders a disabled
 * select fixed at 0, never selectable (invariant I6). The select is non-required in
 * markup; the server fold validates the per-parent total (invariant I9). A bookable
 * child also carries its date/span compatibility attributes ({@link
 * childCompatAttrs}) for the client compatibility script. */
const renderChildOption = (
  parent: ListingWithCount,
  child: TicketListing,
  childCap: number,
  childDatesById: ReadonlyMap<string, ChildSpanDates>,
  showZero: boolean,
): string => {
  const parentId = parent.id;
  const { listing } = child;
  const bookable = childBookable(child);
  const selectName = `child_qty_${parentId}_${listing.id}`;
  const priceHtml =
    listing.can_pay_more && bookable
      ? renderPayMoreInput(
          listing,
          `child_price_${parentId}_${listing.id}`,
          undefined,
          false,
        )
      : "";
  const label = bookable
    ? `${escapeHtml(listing.name)} ${childPriceLabel(listing, parent, showZero)}`.trim()
    : escapeHtml(t("public.ticket.child_unavailable", { name: listing.name }));
  const select = bookable
    ? `<select name="${selectName}" data-child-qty="${listing.id}"${childCompatAttrs(
        parentId,
        child,
        childDatesById,
      )}>${quantityOptions(
        childCap,
        restoredChildQty(parentId, listing.id, childCap),
      )}</select>`
    : `<select name="${selectName}" disabled><option value="0" selected>0</option></select>`;
  return `<label class="child-option">${select} ${label}</label>${priceHtml}`;
};

/** Render a sole bookable child as INFORMATIONAL (auto-select preserved): no
 * submitted `child_qty_<parentId>_<childId>` field at all — the server fold
 * auto-fills the sole child to the parent's quantity Q whenever nothing was
 * submitted, so emitting a fixed quantity would over-submit and the fold would
 * reject it as "too many" when Q is below that cap (parents.md Fix 1). Instead show
 * just the child's name plus its (non-zero) price, and — for a pay-more sole child
 * — its (non-required) price input, which the fold reads for the auto-selected
 * child. No-JS safe: nothing posts a quantity for it.
 *
 * The buyer makes no choice for a sole child, so it carries no "choose an option"
 * prompt (that lives on the parent's `<legend>`, suppressed for a sole child — see
 * {@link renderChildBlock}). A HIDDEN child shows nothing visible — the operator
 * hid it from public view — but keeps its data markers and pay-more price input so
 * the fold and the compat/required client scripts still drive off them (Fix 1).
 *
 * The informational marker ALSO carries the same date/span compatibility
 * attributes a selectable child option does ({@link childCompatAttrs}) so on a
 * group/multi-listing page (where the date/day-count controls aren't globally
 * constrained to the child's calendar) the client script can tell the auto-selected
 * sole child can't serve the chosen date/span and flag/disable the parent — rather
 * than letting the buyer hit the submit-side `child_sold_out` rejection (parents.md
 * Fix 1). */
const renderSoleChildOption = (
  parent: ListingWithCount,
  child: TicketListing,
  childDatesById: ReadonlyMap<string, ChildSpanDates>,
  showZero: boolean,
): string => {
  const parentId = parent.id;
  const { listing } = child;
  const priceHtml = listing.can_pay_more
    ? renderPayMoreInput(
        listing,
        `child_price_${parentId}_${listing.id}`,
        undefined,
        false,
      )
    : "";
  const visible = !listing.hidden;
  const namePart = visible ? escapeHtml(listing.name) : "";
  const pricePart = visible ? childPriceLabel(listing, parent, showZero) : "";
  const label = `${namePart} ${pricePart}`.trim();
  return `<p class="child-option child-sole" data-sole-parent="${parentId}" data-sole-child="${listing.id}"${childCompatAttrs(
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
 * no children. Requiredness/totals are enforced server-side (invariant I9).
 */
const renderChildBlock = (
  parentInfo: TicketListing,
  ctx: ChildRenderCtx,
): string => {
  const parent = parentInfo.listing;
  const parentId = parent.id;
  const children = ctx.children.get(parentId);
  if (!children || children.length === 0) return "";
  const bookable = children.filter(childBookable);
  // The parent's effective max is the per-parent total ceiling; each child select is
  // additionally capped by its own parent+child order capacity (below).
  const total = childCappedMax(parentInfo, ctx);
  // A SOLE bookable child is auto-selected by the fold (informational), so the buyer
  // makes no choice: suppress the "choose an option" legend and the "choose N in
  // total" guidance (Fix 1) and let the child option show its name directly.
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
            childBookable(child)
              ? Math.min(
                  total,
                  childOrderCap(
                    parentInfo,
                    child,
                    ctx.groupRemainingByGroupId,
                    ctx.groupIdsByListingId,
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
  // sole auto-selected child — nothing for the buyer to choose (Fix 1).
  const note = sole
    ? ""
    : `<p class="child-total-note" data-child-total="${parentId}">` +
      `${escapeHtml(t("public.ticket.choose_total", { count: total }))} ` +
      `<span class="child-total-hint" data-child-hint="${parentId}"></span></p>`;
  const legend = sole
    ? ""
    : `<legend>${escapeHtml(t("public.ticket.choose_option", { name: parent.name }))}</legend>`;
  return (
    `<fieldset class="child-selector" data-parent-id="${parentId}">` +
    `${legend}${note}${options}${questionsHtml}</fieldset>`
  );
};

/** Render quantity selector for an listing row.
 *
 * An optional per-listing `prefill` pre-selects the quantity (clamped to the
 * available range) — used by multi-listing scenarios such as the order cart. */
const renderListingRow = (
  info: TicketListing,
  hideQuantity = false,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const { listing, isSoldOut, isClosed } = info;
  const maxPurchasable = childCappedMax(info, childCtx);
  const fieldName = `quantity_${listing.id}`;
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
  const priceFieldName = `custom_price_${listing.id}`;
  const prefilledPrice = prefill ? prefill.customPriceMinor : undefined;
  const childBlock = childCtx ? renderChildBlock(info, childCtx) : "";

  return `
    <div class="ticket-row">
      ${imageHtml}
      <label>${escapeHtml(listing.name)}${quantityHtml}</label>
      ${renderListingDescription(listing.description)}
      ${
        showPayMore
          ? renderPayMoreInput(listing, priceFieldName, prefilledPrice)
          : ""
      }
      ${childBlock}
    </div>
  `;
};

/** A package member row: name + fixed per-package quantity, read-only — the
 * buyer chooses the package count, not per-member quantities. */
const renderPackageMemberRow = (
  info: TicketListing,
  fixedQty: number,
): string => `
    <div class="ticket-row package-member">
      ${renderListingImage(info.listing)}
      <label>${escapeHtml(info.listing.name)} <span class="package-member-qty">&times;${fixedQty}</span></label>
      ${renderListingDescription(info.listing.description)}
    </div>
  `;

/** A package booking page's listing area: the single "number of packages"
 * selector, then each member row (each showing its fixed quantity) — unless the
 * package hides its listings from buyers, in which case only the selector shows.
 * `cap` is the most packages the tightest member's capacity allows. */
const renderPackageRows = (
  listings: TicketListing[],
  quantities: ReadonlyMap<number, number>,
  cap: number,
  hide: boolean,
): string => {
  // Every member listing id, so the client knows which listing-scoped questions
  // to show/require once a package is selected — even when members are hidden and
  // render no rows of their own.
  const memberIds = listings.map((e) => e.listing.id).join(" ");
  const selector = `<label>${t(
    "public.package.quantity",
  )}<select name="package_quantity" data-package-members="${memberIds}">${quantityOptions(
    cap,
    restoredPackageQuantity(cap),
  )}</select></label>`;
  const members = hide
    ? ""
    : listings
        .map((e) =>
          renderPackageMemberRow(e, quantities.get(e.listing.id) ?? 1),
        )
        .join("");
  return selector + members;
};

/** The most packages the buyer can order. Two bounds apply: each member's own
 * remaining capacity divided by how many of it one package includes (a
 * closed/sold-out member has `maxPurchasable` 0, capping the package at 0); and,
 * when the package group itself is capacity-capped, the shared pool divided by
 * the TOTAL members one package consumes (`packageGroupRemaining` ÷ Σ memberQty)
 * — without which two members sharing the pool would each look individually
 * available while only fewer packages actually fit. Exported so the submit path
 * clamps the posted count to the same ceiling. */
export const packageQuantityCap = (
  listings: TicketListing[],
  quantities: ReadonlyMap<number, number>,
  packageGroupRemaining?: number | null,
): number => {
  const qtyOf = (e: TicketListing) => quantities.get(e.listing.id) ?? 1;
  const perMember = Math.min(
    ...listings.map((e) => Math.floor(e.maxPurchasable / qtyOf(e))),
  );
  if (packageGroupRemaining == null) return perMember;
  // How many member units one package consumes from the shared pool.
  const perPackage = listings.reduce((n, e) => n + qtyOf(e), 0);
  return Math.min(perMember, Math.floor(packageGroupRemaining / perPackage));
};

/** Render controls for a single listing: quantity input + pay-more (no listing name/image/description). */
const renderSingleListingControls = (
  info: TicketListing,
  hideQuantity: boolean,
  prefill?: TicketPrefill,
  childCtx?: ChildRenderCtx,
): string => {
  const { listing } = info;
  const maxPurchasable = childCappedMax(info, childCtx);
  const fieldName = `quantity_${listing.id}`;
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
  const priceFieldName = `custom_price_${listing.id}`;
  const childBlock = childCtx ? renderChildBlock(info, childCtx) : "";
  return `${quantityHtml}${
    showPayMore
      ? renderPayMoreInput(listing, priceFieldName, prefilledPrice)
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
  /** Each DAILY child's holiday-aware serveable start dates per selectable parent
   * span, keyed by the (parent, child) PAIR ({@link ChildRenderCtx.childDatesById},
   * Fix 4). Omitted/empty when no daily children. */
  childDatesById?: ReadonlyMap<string, ChildSpanDates>;
  /** Each GROUP id → its remaining spots (uncapped groups omitted), so a parent
   * sharing a capped group with its child clamps its quantity by the combined
   * parent+child demand against the SPECIFIC shared group (invariant I7, Fix 3,
   * Codex #2/#3). Empty/omitted when no group caps apply. */
  groupRemainingByGroupId?: ReadonlyMap<number, number>;
  /** Each listing id → the ids of the groups it belongs to, so the shared-group
   * clamps resolve the group a parent and child share. Empty/omitted = ungrouped. */
  groupIdsByListingId?: ReadonlyMap<number, number[]>;
  /** Package overrides (listing id → price) when this is a package page, so a
   * member whose base price is 0 but override is paid still renders the provider
   * contact fields. Empty/omitted for non-package pages. */
  packagePrices?: ReadonlyMap<number, number> | null | undefined;
  /** Set on a package page: the group id, each member's fixed per-package
   * quantity, and whether members are hidden from buyers. When set, the page
   * shows one package-quantity selector instead of per-member quantities. */
  packageGroupId?: number | null;
  packageQuantities?: ReadonlyMap<number, number> | null;
  /** The package group's own remaining pool when capped, bounding the package
   * count by `floor(remaining / Σ memberQty)` (combined member demand). `null`
   * when uncapped; omitted for non-package pages. */
  packageGroupRemaining?: number | null;
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
  singleListing,
  pastDays,
}: {
  headerName: string;
  headerDescription: string | null | undefined;
  singleListing: ListingWithCount | null;
  pastDays: number | null;
}): JSX.Element => (
  <>
    {singleListing && <Raw html={renderListingImage(singleListing)} />}
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
            <span class="badge-alert">
              {" "}
              {t("public.ticket.days_ago", { count: pastDays })}
            </span>
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
  dayCounts: constrainDayCountsByChildUnion(
    listings,
    sharedDayCounts(listings),
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
  childDatesById: ReadonlyMap<string, ChildSpanDates>,
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
      groupIdsByListingId,
      groupRemainingByGroupId,
      questionListingMap,
      questions,
      rendered: new Set<number>(pageQuestions.map((q) => q.id)),
    },
    pageQuestions,
  };
};

/** Whether a listing is paid in context — its own pricing, or a package override
 * that makes an otherwise-free member cost money. */
const paidInContext = (
  listing: TicketListing,
  packagePrices: ReadonlyMap<number, number> | null | undefined,
): boolean =>
  isPaidListing(listing.listing) ||
  (packagePrices?.get(listing.listing.id) ?? 0) > 0;

/** Whether the page itself (its listings or add-ons, NOT possible children) is
 * paid — so its provider-imposed email renders required. */
const pagePaid = (
  listings: TicketListing[],
  addOns: AddOnOption[] | undefined,
  packagePrices: ReadonlyMap<number, number> | null | undefined,
): boolean =>
  listings.some((e) => paidInContext(e, packagePrices)) ||
  (addOns?.some((addOn) => addOn.requiresPayment) ?? false);

/** Whether the contact-field set must include a paid order's provider-imposed
 * fields: any page listing, possible child, or add-on is paid. A free parent with
 * a paid child still needs the email field present (non-required, enforced
 * server-side when the folded order is actually paid). */
const pageOrChildPaid = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  addOns: AddOnOption[] | undefined,
  packagePrices: ReadonlyMap<number, number> | null | undefined,
): boolean => {
  const children = childrenByParentId
    ? [...childrenByParentId.values()].flat()
    : [];
  return (
    pagePaid(listings, addOns, packagePrices) ||
    children.some((e) => isPaidListing(e.listing))
  );
};

/** Render the per-listing rows (with their child blocks). A single-listing page
 * shows just the controls (details live in the header); multi-listing pages
 * show a compact row each. Both honour per-listing quantity pre-fills. */
const buildListingRows = (
  listings: TicketListing[],
  isSingleListing: boolean,
  hideQuantity: boolean,
  prefill: BookingPrefill | undefined,
  childCtx: ChildRenderCtx | undefined,
): string =>
  isSingleListing
    ? renderSingleListingControls(
        listings[0]!,
        hideQuantity,
        prefill?.listings.get(listings[0]!.listing.id),
        childCtx,
      )
    : listings
        .map((e) =>
          renderListingRow(
            e,
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
  packageQuantities: ReadonlyMap<number, number> | null | undefined;
  packageGroupRemaining?: number | null | undefined;
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
      packageQuantityCap(opts.listings, quantities, opts.packageGroupRemaining),
      opts.hidePackageListings,
    );
  }
  return buildListingRows(
    opts.listings,
    opts.isSingleListing,
    opts.hideQuantity,
    opts.prefill,
    opts.childCtx,
  );
};

/** The lone listing whose rich details (image/date/location) head the page and
 * feed its OpenGraph tags, or null for a multi-listing page OR a hidden package
 * — a hidden package with one active member must not expose that member here. */
const headerListing = (
  listings: TicketListing[],
  hidePackageListings: boolean,
): ListingWithCount | null =>
  listings.length === 1 && !hidePackageListings ? listings[0]!.listing : null;

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
  prefill,
  actionUrl,
  addOns,
  promoCodesEnabled,
  childrenByParentId,
  childDatesById,
  groupRemainingByGroupId,
  groupIdsByListingId = new Map(),
  packagePrices,
  packageGroupId,
  packageQuantities,
  packageGroupRemaining,
  hidePackageListings = false,
}: TicketPageOptions): string => {
  // getTicketContext always sets packageQuantities alongside packageGroupId.
  const isPackage = packageGroupId != null;
  const inIframe = getIframeMode();
  const allUnavailable = listings.every((e) => e.isSoldOut || e.isClosed);
  const allClosed = listings.every((e) => e.isClosed);
  const fields: Field[] = buildContactFields(
    listings,
    childrenByParentId,
    pagePaid(listings, addOns, packagePrices),
    pageOrChildPaid(listings, childrenByParentId, addOns, packagePrices),
  );
  const hasDaily = listings.some((e) => e.listing.listing_type === "daily");

  const singleListing = headerListing(listings, hidePackageListings);
  const isSingleListing = singleListing !== null;
  const pastDays = singleListing?.date ? daysAgo(singleListing.date) : null;

  const { hasCustomisable, dayCounts, dayCountPriceFor, dateDurationDays } =
    dayConfig(listings, singleListing, childrenByParentId);

  const availableListings = listings.filter((e) => !e.isSoldOut && !e.isClosed);
  const hideQuantity =
    availableListings.length === 1 &&
    availableListings[0]?.maxPurchasable === 1;

  const { pageQuestions, childCtx } = splitChildQuestions(
    listings,
    questions ?? [],
    questionListingMap,
    childrenByParentId,
    groupRemainingByGroupId ?? new Map(),
    childDatesById ?? new Map(),
    groupIdsByListingId,
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
    packageGroupRemaining,
    packageQuantities,
    prefill,
  });

  // Caller-supplied group metadata (groups, renewals) takes priority over
  // single-listing details — the caller knows what page the customer landed on.
  // Plain single-listing pages set no group metadata and fall back to listing
  // name/description.
  const headerName = groupName ?? singleListing?.name;
  const headerDescription = groupDescription ?? singleListing?.description;
  const title = headerName || t("public.multi.title");
  const headExtra =
    singleListing && baseUrl ? buildOgTags(singleListing, baseUrl) : undefined;

  return String(
    <Layout
      bodyClass={inIframe ? "iframe" : undefined}
      headExtra={headExtra}
      title={title}
    >
      {headerName && !inIframe && (
        <TicketPageHeader
          headerDescription={headerDescription}
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
