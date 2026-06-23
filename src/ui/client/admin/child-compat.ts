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
 * serveable starts) and/or `data-child-spans` (a customisable/fixed-daily child's
 * supported day counts). On a change to the page `date` / `day_count` controls we
 * DISABLE and zero any child the current selection can't serve, re-enabling it
 * when a compatible selection returns.
 *
 * Only JS-driven disabling is toggled: a child the SERVER rendered disabled
 * (sold out) carries no `data-child-qty` marker, so it is never touched and stays
 * disabled throughout. */
import {
  childQtyControls,
  initParentSelectors,
  onChangeOf,
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

/** Whether a child control is compatible with the current date/span selection.
 * A constraint only applies once the relevant control has a value: with no date
 * chosen yet, a date-constrained child is left enabled (nothing to reject). A
 * child carrying neither attribute (e.g. a standard child) is always compatible. */
const isCompatible = (
  control: HTMLSelectElement | HTMLInputElement,
  date: string,
  span: string,
): boolean => {
  const dates = control.getAttribute("data-child-dates");
  if (dates !== null && date !== "" && !tokens(dates).includes(date)) {
    return false;
  }
  const spans = control.getAttribute("data-child-spans");
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
 * one. Zeroing keeps the running total and the chosen-count hint honest. */
const applyCompat = (
  control: HTMLSelectElement | HTMLInputElement,
  compatible: boolean,
): void => {
  control.disabled = !compatible;
  if (!compatible) control.value = "0";
};

/** Toggle one parent's bookable child controls against the current selection. */
const updateParent = (parentId: string): void => {
  const date = selectedDate();
  const span = selectedSpan();
  for (const control of managedControls(parentId)) {
    applyCompat(control, isCompatible(control, date, span));
  }
};

/** Register the date/day-count change listeners that drive the compat toggle. */
const onDateOrSpanChange = (update: () => void): void =>
  onChangeOf('[name="date"], [name="day_count"]', update);

export const initChildCompat = (): void =>
  initParentSelectors(onDateOrSpanChange, updateParent);
