/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Disable a child whose date/day-count the current selection can't serve
 * (Codex 430, progressive enhancement).
 *
 * A parent's date and day-count selectors are the UNION across its children's
 * availability, so a buyer can pick a date (or span) only SOME children support.
 * The no-JS baseline lets the buyer put quantity on an incompatible child and the
 * server fold rejects it. With JS we tighten it: each bookable child qty control
 * carries the server's holiday-aware `data-child-dates` (a daily child's
 * serveable starts PER selectable span, encoded `span:d,d|span:d,d` — Fix 4)
 * and/or `data-child-spans` (a customisable/fixed-daily child's supported day
 * counts). On a change to the page `date` / `day_count` controls we DISABLE and
 * zero any child the current selection can't serve, re-enabling it when a
 * compatible selection returns.
 *
 * A SOLE auto-selected child has no `child_qty_*` control (it is informational,
 * the fold auto-fills it). When such a child can't serve the selection there is
 * nothing to disable, yet "Includes …" would still show and the submit would hit
 * `child_sold_out`. So a sole child instead FLAGS/disables its PARENT: its
 * quantity selector is disabled+zeroed and the sole block marked
 * `data-sole-incompatible`, surfacing that the parent can't be booked for that
 * date/span (parents.md Fix 1).
 *
 * Only JS-driven disabling is toggled: a child the SERVER rendered disabled
 * (sold out) carries no `data-child-qty` marker, so it is never touched and stays
 * disabled throughout. */
import {
  childQtyControls,
  initParentSelectors,
  onChangeOf,
  soleChildId,
} from "./child-selection.ts";

/** The page's `name="date"` control's value, or "" when absent. */
const selectedDate = (): string => {
  const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(
    '[name="date"]',
  );
  return control === null ? "" : control.value;
};

/** The page's `name="day_count"` value, or "" when absent/unchosen. Compared as
 * a string against the `data-child-spans` tokens, so no numeric parse is needed
 * (the selector only ever emits "" or an integer span). */
const selectedSpan = (): string => {
  const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(
    '[name="day_count"]',
  );
  return control === null ? "" : control.value;
};

/** Split a (present) comma-separated `data-child-*` attribute into its tokens.
 * Callers only invoke this for an attribute they have confirmed is set. */
const tokens = (raw: string): string[] => raw.split(",");

/** Parse the span-keyed `data-child-dates` wire shape (`span:d,d|span:d,d`,
 * produced by `encodeChildSpanDates`) into a span → dates map (Fix 4). An empty
 * dates segment (`span:`) yields an empty list — the span the child can't serve
 * on any date. */
const parseChildSpanDates = (raw: string): Map<string, string[]> => {
  const bySpan = new Map<string, string[]>();
  for (const segment of raw.split("|")) {
    const sep = segment.indexOf(":");
    const span = segment.slice(0, sep);
    const dates = segment.slice(sep + 1);
    bySpan.set(span, dates === "" ? [] : tokens(dates));
  }
  return bySpan;
};

/** The serveable dates that apply for the current span selection (Fix 4): the
 * entry for the chosen `day_count`, or — when no span is chosen (a fixed-duration
 * parent has no day-count selector, or one hasn't been picked yet) and there is
 * exactly ONE span entry — that single entry. Returns null when the applicable
 * set can't be determined (no span chosen and multiple spans exist), so the date
 * constraint is left un-applied until the buyer picks a day-count. */
const datesForSpan = (
  bySpan: Map<string, string[]>,
  span: string,
): string[] | null => {
  if (span !== "") return bySpan.get(span) ?? null;
  if (bySpan.size === 1) return [...bySpan.values()][0]!;
  return null;
};

/** Whether a child (its `data-child-dates`/`data-child-spans`) is compatible with
 * the current date/span selection. A constraint only applies once the relevant
 * control has a value: with no date chosen yet, a date-constrained child is left
 * enabled (nothing to reject). The date set is picked PER the selected span (Fix
 * 4) — a 2-day span uses the 2-day serveable starts. A child carrying neither
 * attribute (e.g. a standard child) is always compatible. */
const isCompatible = (
  el: { getAttribute: (name: string) => string | null },
  date: string,
  span: string,
): boolean => {
  const dates = el.getAttribute("data-child-dates");
  if (dates !== null && date !== "") {
    const applicable = datesForSpan(parseChildSpanDates(dates), span);
    if (applicable !== null && !applicable.includes(date)) return false;
  }
  const spans = el.getAttribute("data-child-spans");
  if (spans !== null && span !== "" && !tokens(spans).includes(span)) {
    return false;
  }
  return true;
};

/** The bookable child qty controls of a parent — the JS-managed ones, marked
 * with `data-child-qty`. A server-disabled (sold-out) child has no such marker
 * and is deliberately excluded so it is never re-enabled. */
const managedControls = (
  parentId: string,
): (HTMLSelectElement | HTMLInputElement)[] =>
  childQtyControls(parentId).filter(
    (control) => control.getAttribute("data-child-qty") !== null,
  );

/** Disable + zero a control the selection can't serve; re-enable a compatible
 * one. Zeroing keeps the running total and the chosen-count hint honest, and —
 * because zeroing happens in code, not via the buyer — dispatches a `change` so
 * the dependent enhancement scripts (child-required, question-visibility, running
 * total) recompute against the now-removed child (Fix 2): otherwise its required
 * question / pay-more price input would stay visible and required and block
 * submit. The event is only fired when the control actually changes to disabled
 * (a still-compatible re-enable doesn't alter the chosen quantity). */
const applyCompat = (
  control: HTMLSelectElement | HTMLInputElement,
  compatible: boolean,
): void => {
  if (compatible) {
    control.disabled = false;
    return;
  }
  const hadQuantity = control.value !== "0";
  control.disabled = true;
  control.value = "0";
  // Notify dependents only when a chosen quantity was actually cleared, so the
  // question/price for the dropped child re-runs its show/require logic.
  if (hadQuantity) {
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
};

/** The sole auto-selected child's informational marker, or null when the parent
 * has multi-child `child_qty_*` controls instead. */
const soleMarker = (parentId: string): HTMLElement | null =>
  soleChildId(parentId) === null
    ? null
    : document.querySelector<HTMLElement>(`[data-sole-parent="${parentId}"]`);

/** A sole child can't be disabled directly (it has no quantity control), so its
 * incompatibility is surfaced on its PARENT (Fix 1): the parent's quantity
 * selector is disabled+zeroed and the sole block flagged `data-sole-incompatible`
 * — surfacing that the parent can't be booked for the chosen date/span rather
 * than showing "Includes …" and hitting the submit-side rejection. A compatible
 * selection re-enables the parent and clears the flag. The quantity is fired as a
 * `change` when it is actually cleared so the dependent scripts recompute (the
 * sole child becomes inactive once the parent leaves the cart). */
const applySoleCompat = (
  parentId: string,
  marker: HTMLElement,
  date: string,
  span: string,
): void => {
  const compatible = isCompatible(marker, date, span);
  marker.toggleAttribute("data-sole-incompatible", !compatible);
  const quantity = document.querySelector<HTMLSelectElement | HTMLInputElement>(
    `[name="quantity_${parentId}"]`,
  );
  if (quantity === null) return;
  if (compatible) {
    quantity.disabled = false;
    return;
  }
  const hadQuantity = quantity.value !== "0";
  quantity.disabled = true;
  quantity.value = "0";
  if (hadQuantity) {
    quantity.dispatchEvent(new Event("change", { bubbles: true }));
  }
};

/** Toggle one parent's bookable child controls (or, for a sole child, the
 * parent itself) against the current selection. */
const updateParent = (parentId: string): void => {
  const date = selectedDate();
  const span = selectedSpan();
  const sole = soleMarker(parentId);
  if (sole !== null) {
    applySoleCompat(parentId, sole, date, span);
    return;
  }
  for (const control of managedControls(parentId)) {
    applyCompat(control, isCompatible(control, date, span));
  }
};

/** Register the date/day-count change listeners that drive the compat toggle. */
const onDateOrSpanChange = (update: () => void): void =>
  onChangeOf('[name="date"], [name="day_count"]', update);

export const initChildCompat = (): void =>
  initParentSelectors(onDateOrSpanChange, updateParent);
