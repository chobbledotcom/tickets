/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Progressive enhancement. A parent's date and day-count selectors are the
 * union across its children, so a buyer can pick a date only some children
 * support. Without JS the server fold rejects that at submit, and this tightens
 * it earlier.
 *
 * A sole auto-selected child has no quantity control to disable, so it disables
 * its parent instead.
 *
 * Only JS-driven disabling is toggled. A SERVER-disabled child carries no
 * `data-child-qty` marker, so it is never touched. */
import {
  childQtyControls,
  fireChange,
  initParentSelectors,
  onChangeOf,
  setControlDisabled,
  soleChildId,
} from "./child-selection.ts";

/** The value of the `[name=...]` control, or "" when it's absent. */
const controlValue = (name: string): string => {
  const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(
    `[name="${name}"]`,
  );
  return control === null ? "" : control.value;
};

/** The `name="date"` control's value, or "" when absent. */
const selectedDate = (): string => controlValue("date");

/** The `name="day_count"` value, or "" when absent/unchosen. Compared as a string
 * against the `data-child-spans` tokens, so no numeric parse is needed (the
 * selector only ever emits "" or an integer span). */
const selectedSpan = (): string => controlValue("day_count");

/** Split a (present) comma-separated `data-child-*` attribute into its tokens. */
const tokens = (raw: string): string[] => raw.split(",");

/** Parse the span-keyed `data-child-dates` wire shape (`span:d,d|span:d,d`, from
 * `encodeChildDatesByDayCount`) into a span → dates map. An empty dates segment
 * (`span:`) yields an empty list — a span the child can't serve on any date. */
const parseChildDatesByDayCount = (raw: string): Map<string, string[]> => {
  const bySpan = new Map<string, string[]>();
  for (const segment of raw.split("|")) {
    const sep = segment.indexOf(":");
    const span = segment.slice(0, sep);
    const dates = segment.slice(sep + 1);
    bySpan.set(span, dates === "" ? [] : tokens(dates));
  }
  return bySpan;
};

/** The serveable dates that apply for the current span selection: the
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
 * date set is picked PER the selected span — a 2-day span uses the 2-day
 * serveable starts. A child carrying neither attribute (e.g. a standard child) is
 * always compatible. */
const isCompatible = (
  el: { getAttribute: (name: string) => string | null },
  date: string,
  span: string,
): boolean => {
  const dates = el.getAttribute("data-child-dates");
  if (dates !== null && date !== "") {
    const applicable = datesForSpan(parseChildDatesByDayCount(dates), span);
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
 * pay-more price input stops blocking submit. */
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
 * incompatibility is surfaced on its PARENT: the parent's quantity selector
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
  // A single-parent sole-child page auto-hides the parent quantity as a hidden
  // `value="1"` input, so when an incompatible selection zeroed it, re-enabling
  // alone would leave it at "0" with no visible control to fix — the form then
  // submits no parent ticket and fails "select at least one ticket". Restore the
  // hidden auto-quantity to 1 so a compatible selection books the parent again
  // (a visible select instead keeps the buyer's choice, which they can re-pick).
  if (compatible && quantity.type === "hidden") {
    quantity.value = "1";
    fireChange(quantity);
  }
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
