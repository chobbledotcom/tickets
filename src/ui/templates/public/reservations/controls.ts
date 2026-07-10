/** Small string-returning form control renderers for the ticket page: the date
 * selector, the day-count selector, the pay-more price input, and the terms
 * checkbox. Each restores the buyer's just-submitted value on a validation
 * re-render. */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { savedFormValue } from "#shared/forms.tsx";
import { renderMarkdown } from "#shared/markdown.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { moneyPattern } from "#templates/components/price-input.tsx";
import { escapeHtml } from "#templates/layout.tsx";
/* jscpd:ignore-end */

/** A date-selector dropdown for daily listings. */
export const renderDateSelector = (
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
export const renderDayCountSelector = (
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
