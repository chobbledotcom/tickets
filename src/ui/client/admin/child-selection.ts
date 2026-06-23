/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Shared helpers for the parent/child booking gate's client enhancement.
 *
 * A folded child is never an ordinary `quantity_<id>` line — it is chosen via a
 * per-parent `child_<parentId>` radio and its quantity is slaved to the parent.
 * So the "is this listing active?" question the visibility/required scripts ask
 * has two sources: page listings with `quantity_<id> > 0`, and the selected
 * child of every in-cart parent. These helpers compute that effective set and
 * locate the child controls, so both scripts drive off one definition. */

/** The numeric quantity of a `quantity_<id>` control, or 0 when absent/blank. */
const quantityValue = (id: string): number => {
  const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(
    `[name="quantity_${id}"]`,
  );
  if (control === null) return 0;
  const parsed = Number.parseInt(control.value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** The value of the checked radio in a `child_<parentId>` group, or "" when
 * none is checked. */
const selectedChildId = (parentId: string): string => {
  const checked = document.querySelector<HTMLInputElement>(
    `input[name="child_${parentId}"]:checked`,
  );
  return checked === null ? "" : checked.value;
};

/** Every parent id with a rendered `child_<parentId>` selector on the page. */
export const childSelectorParentIds = (): string[] => {
  const ids: string[] = [];
  for (const fieldset of document.querySelectorAll<HTMLElement>(
    "fieldset.child-selector[data-parent-id]",
  )) {
    ids.push(fieldset.dataset.parentId!);
  }
  return ids;
};

/** Whether the given parent is in the cart (`quantity_<parentId> > 0`). */
export const parentInCart = (parentId: string): boolean =>
  quantityValue(parentId) > 0;

/** The effective set of "active" listing ids: every page listing with quantity
 * > 0, plus the selected child of each in-cart parent. Drives the existing
 * question show/require machinery so a child-only question is active exactly
 * when its child is the chosen child of an in-cart parent. */
export const selectedListingIds = (): Set<string> => {
  const ids = new Set<string>();
  for (const control of document.querySelectorAll<
    HTMLSelectElement | HTMLInputElement
  >('[name^="quantity_"]')) {
    // The selector guarantees a `quantity_`-prefixed name attribute.
    const id = control.getAttribute("name")!.slice("quantity_".length);
    if (quantityValue(id) > 0) ids.add(id);
  }
  for (const parentId of childSelectorParentIds()) {
    if (!parentInCart(parentId)) continue;
    const childId = selectedChildId(parentId);
    if (childId !== "") ids.add(childId);
  }
  return ids;
};

/** Run `listener` whenever a selection that can change the active-listing set
 * changes: any quantity control, or any per-parent child radio. */
export const onSelectionChange = (listener: () => void): void => {
  for (const control of document.querySelectorAll<
    HTMLSelectElement | HTMLInputElement
  >('[name^="quantity_"], input[name^="child_"]')) {
    control.addEventListener("change", listener);
  }
};
