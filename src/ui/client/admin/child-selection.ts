/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Shared helpers for the parent/child booking gate's client enhancement.
 *
 * A folded child is never an ordinary `quantity_<id>` line — under the per-unit
 * selection model it is chosen via a per-child `child_qty_<parentId>_<childId>`
 * quantity control whose total across a parent's children equals the parent's
 * quantity. So the "is this listing active?" question the visibility/required
 * scripts ask has two sources: page listings with `quantity_<id> > 0`, and every
 * child given a positive `child_qty_*` under an in-cart parent. These helpers
 * compute that effective set and locate the child controls, so both scripts
 * drive off one definition. */

/** The numeric value of a quantity-style control (`quantity_<id>`,
 * `child_qty_*`), or 0 when absent/blank/invalid. A disabled control counts as 0
 * (a sold-out child can never be selected). The single source both scripts read
 * a quantity through, so the parse rule lives in one place. */
export const controlQty = (
  control: HTMLSelectElement | HTMLInputElement | null,
): number => {
  if (control === null || control.disabled) return 0;
  const parsed = Number.parseInt(control.value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
};

/** The numeric quantity of a `quantity_<id>` control, or 0 when absent/blank. */
export const quantityValue = (id: string): number =>
  controlQty(
    document.querySelector<HTMLSelectElement | HTMLInputElement>(
      `[name="quantity_${id}"]`,
    ),
  );

/** Every `child_qty_<parentId>_<childId>` control of a parent. */
export const childQtyControls = (
  parentId: string,
): (HTMLSelectElement | HTMLInputElement)[] => [
  ...document.querySelectorAll<HTMLSelectElement | HTMLInputElement>(
    `[name^="child_qty_${parentId}_"]`,
  ),
];

/** The child id encoded in a `child_qty_<parentId>_<childId>` control's name. */
export const childIdOf = (
  parentId: string,
  control: HTMLSelectElement | HTMLInputElement,
): string =>
  control.getAttribute("name")!.slice(`child_qty_${parentId}_`.length);

/** The total per-unit quantity chosen across a parent's child controls. */
export const childQtyTotal = (parentId: string): number =>
  childQtyControls(parentId).reduce(
    (sum, control) => sum + controlQty(control),
    0,
  );

/** The child ids with a positive chosen quantity under a parent (its `child_qty_*`
 * controls). Shared by the active-listing set and the required-price toggling. */
export const chosenChildIds = (parentId: string): Set<string> =>
  new Set(
    childQtyControls(parentId)
      .filter((control) => controlQty(control) > 0)
      .map((control) => childIdOf(parentId, control)),
  );

/** Every parent id with a rendered child selector on the page. */
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
 * > 0, plus every child given a positive `child_qty_*` under an in-cart parent.
 * Drives the existing question show/require machinery so a child-only question is
 * active exactly when its child has a chosen quantity under an in-cart parent. */
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
    for (const childId of chosenChildIds(parentId)) ids.add(childId);
  }
  return ids;
};

/** Add a `change` listener to every control matching `selector`. The one place
 * the enhancement scripts wire change handlers, so the query + listener loop
 * lives once. */
export const onChangeOf = (selector: string, listener: () => void): void => {
  for (const control of document.querySelectorAll<
    HTMLSelectElement | HTMLInputElement
  >(selector)) {
    control.addEventListener("change", listener);
  }
};

/** Run `listener` whenever a selection that can change the active-listing set
 * changes: any quantity control, or any per-child quantity control. */
export const onSelectionChange = (listener: () => void): void =>
  onChangeOf('[name^="quantity_"], [name^="child_qty_"]', listener);

/** Shared init scaffold for the parent/child enhancement scripts: no-op when the
 * page has no child selector, otherwise wire `perParent` to run for every parent
 * id on each change `register` reports (and once immediately). Both
 * `initChildRequired` and `initChildCompat` differ only in their `register`
 * (which controls drive the update) and `perParent` (what they toggle). */
export const initParentSelectors = (
  register: (update: () => void) => void,
  perParent: (parentId: string) => void,
): void => {
  const parentIds = childSelectorParentIds();
  if (parentIds.length === 0) return;
  const update = (): void => {
    for (const parentId of parentIds) perParent(parentId);
  };
  register(update);
  update();
};
