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
 * counts). On a `date` / `day_count` change we DISABLE and zero any child the
 * current selection can't serve, re-enabling it when a compatible selection returns.
 *
 * A SOLE auto-selected child has no `child_qty_*` control (it is informational,
 * the fold auto-fills it), so there is nothing to disable, yet "Includes …" would
 * still show and the submit would hit `child_sold_out`. So a sole child instead
 * FLAGS/disables its PARENT: its quantity selector is disabled+zeroed and the sole
 * block marked `data-sole-incompatible`, surfacing that the parent can't be booked
 * for that date/span (parents.md Fix 1).
 *
 * Only JS-driven disabling is toggled: a SERVER-disabled (sold out) child carries
 * no `data-child-qty` marker, so it is never touched and stays disabled throughout. */
import {
  childQtyControls,
  initParentSelectors,
  onChangeOf,
  setControlDisabled,
  soleChildId,
} from "./child-selection.ts";

/** The `name="date"` control's value, or "" when absent. */
const selectedDate = (): string => {
  const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(
    '[name="date"]',
  );
  return control === null ? "" : control.value;
};

/** The `name="day_count"` value, or "" when absent/unchosen. Compared as a string
 * against the `data-child-spans` tokens, so no numeric parse is needed (the
 * selector only ever emits "" or an integer span). */
const selectedSpan = (): string => {
  const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(
    '[name="day_count"]',
  );
  return control === null ? "" : control.value;
};

/** Split a (present) comma-separated `data-child-*` attribute into its tokens. */
const tokens = (raw: string): string[] => raw.split(",");

/** Parse the span-keyed `data-child-dates` wire shape (`span:d,d|span:d,d`, from
 * `encodeChildSpanDates`) into a span → dates map (Fix 4). An empty dates segment
 * (`span:`) yields an empty list — a span the child can't serve on any date. */
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
 * entry for the chosen `day_count`, or — when no span is chosen (fixed-duration
 * parent, or not picked yet) and there is exactly ONE span entry — that single
 * entry. Returns null when no span is chosen and multiple spans exist, leaving the
 * date constraint un-applied until the buyer picks a day-count. */
const datesForSpan = (
  bySpan: Map<string, string[]>,
  span: string,
): string[] | null => {
  if (span !== "") return bySpan.get(span) ?? null;
  if (bySpan.size === 1) return [...bySpan.values()][0]!;
  return null;
};

/** Whether a child (its `data-child-dates`/`data-child-spans`) is compatible with
 * the current date/span selection. A constraint only applies once its control has
 * a value, so with no date chosen yet a date-constrained child stays enabled. The
 * date set is picked PER the selected span (Fix 4) — a 2-day span uses the 2-day
 * serveable starts. A child carrying neither attribute (e.g. a standard child) is
 * always compatible. */
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

/** The JS-managed (`data-child-qty`-marked) child qty controls of a parent. A
 * server-disabled (sold-out) child has no such marker and is deliberately excluded
 * so it is never re-enabled. */
const managedControls = (
  parentId: string,
): (HTMLSelectElement | HTMLInputElement)[] =>
  childQtyControls(parentId).filter(
    (control) => control.getAttribute("data-child-qty") !== null,
  );

/** Disable + zero a control the selection can't serve; re-enable a compatible one.
 * Zeroing keeps the running total and chosen-count hint honest and, via
 * `setControlDisabled`, fires a `change` so the removed child's required question /
 * pay-more price input stops blocking submit (Fix 2). */
const applyCompat = (
  control: HTMLSelectElement | HTMLInputElement,
  compatible: boolean,
): void => setControlDisabled(control, !compatible);

/** The sole auto-selected child's informational marker, or null when the parent
 * uses multi-child `child_qty_*` controls instead. */
const soleMarker = (parentId: string): HTMLElement | null =>
  soleChildId(parentId) === null
    ? null
    : document.querySelector<HTMLElement>(`[data-sole-parent="${parentId}"]`);

/** A sole child can't be disabled directly (it has no quantity control), so its
 * incompatibility is surfaced on its PARENT (Fix 1): the parent's quantity selector
 * is disabled+zeroed and the sole block flagged `data-sole-incompatible` — showing
 * the parent can't be booked for the chosen date/span rather than showing "Includes
 * …" and hitting the submit-side rejection. A compatible selection re-enables the
 * parent and clears the flag. */
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
  setControlDisabled(quantity, !compatible);
};

/** Toggle one parent's bookable child controls (or, for a sole child, the parent
 * itself) against the current selection. */
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
