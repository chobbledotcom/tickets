import { t } from "#i18n";
import {
  packageQuantityFieldName,
  quantityFieldName,
} from "#shared/booking/tree.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import {
  renderSelectOptions,
  type SelectOption,
  savedFormValue,
} from "#shared/forms.tsx";
import { renderMarkdown } from "#shared/markdown.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { moneyPattern } from "#templates/components/price-input.tsx";
import { escapeHtml } from "#templates/layout.tsx";

/** Everything one of the booking form's labeled dropdowns needs: an error box
 * when there is nothing to choose from, else a label plus a required select
 * with a placeholder option in front of the choices. */
type LabeledSelect = {
  name: string;
  /** Trusted label HTML (the date selector appends a duration hint). */
  label: string;
  placeholder: string;
  /** Shown instead of the select when there are no options. */
  emptyError: string;
  options: SelectOption[];
};

/** The one shell behind the booking form's date and day-count pickers. */
const renderLabeledSelect = ({
  name,
  label,
  placeholder,
  emptyError,
  options,
}: LabeledSelect): string =>
  options.length === 0
    ? `<div class="error">${emptyError}</div>`
    : `<label for="${name}">${label}</label>
       <select name="${name}" id="${name}" required>
         <option value="">${placeholder}</option>
         ${renderSelectOptions(options)}
       </select>`;

/** A date-selector dropdown for daily listings. */
export const renderDateSelector = (
  dates: string[],
  selected = "",
  durationDays = 1,
): string =>
  renderLabeledSelect({
    emptyError: t("public.ticket.no_dates_available"),
    label: `${t("public.ticket.select_date")}${
      durationDays > 1
        ? ` <small>(${t("public.ticket.date_duration_hint", {
            durationDays,
          })})</small>`
        : ""
    }`,
    name: "date",
    options: dates.map((d) => ({
      label: formatDateLabel(d),
      selected: d === selected,
      value: d,
    })),
    placeholder: t("public.ticket.select_date_placeholder"),
  });

/** Render the "number of days" selector for customisable-days listings. When a
 * single listing drives the page, each option shows its price for that span.
 * The submitted day count is restored when a validation error re-renders. */
export const renderDayCountSelector = (
  counts: number[],
  priceFor?: (days: number) => number | null,
): string => {
  const selected = savedFormValue("day_count");
  return renderLabeledSelect({
    emptyError: t("public.ticket.no_booking_lengths"),
    label: t("public.ticket.number_of_days"),
    name: "day_count",
    options: counts.map((n) => {
      const price = priceFor?.(n);
      const suffix =
        price !== undefined && price !== null
          ? ` — ${formatCurrency(price)}`
          : "";
      return {
        label: `${t("public.ticket.day_option", { count: n })}${suffix}`,
        selected: selected === String(n),
        value: String(n),
      };
    }),
    placeholder: t("public.ticket.select_placeholder"),
  });
};

/** A price input for pay-more listings. `required` is the HTML constraint: page
 * listings emit a required input when the minimum price is above zero, but a
 * child's pay-more input renders non-required — the no-JS baseline emits one for
 * every pay-more child of a parent, so a `required` input would block submit
 * demanding a price for an UNSELECTED child; the server validates only the chosen
 * child's price. */
export const renderPayMoreInput = (
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
export const renderTermsAndCheckbox = (terms: string): string => {
  const checked = savedFormValue("agree_terms") === "1" ? " checked" : "";
  return (
    `<div class="prose">${renderMarkdown(terms)}</div>` +
    `<label class="terms-agree"><input type="checkbox" name="agree_terms" value="1"${checked} required> ${t(
      "public.ticket.agree_terms",
    )}</label>`
  );
};

/** An `<option>` list `0..max` for a quantity selector, with `selected` chosen. */
export const quantityOptions = (max: number, selected: number): string =>
  renderSelectOptions(
    Array.from({ length: max + 1 }, (_, i) => ({
      label: String(i),
      selected: i === selected,
      value: String(i),
    })),
  );

/** Per-listing pre-fill applied when scanning a signed QR link */
export type TicketPrefill = {
  quantity?: number;
  /** Pre-fill the custom_price input for can_pay_more listings (minor units) */
  customPriceMinor?: number;
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
export const clampSavedQuantity = (
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
export const restoredQuantity = (
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
export const restoredPackageQuantity = (
  groupId: number,
  limit: number,
): number =>
  clampSavedQuantity(
    savedFormValue(packageQuantityFieldName(groupId)),
    limit,
    Math.min(1, limit),
  );
