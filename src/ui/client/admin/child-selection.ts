/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Shared helpers for the parent/child booking gate's client enhancement.
 *
 * A folded child is never an ordinary `quantity_<id>` line — under the per-unit
 * selection model it is chosen via a per-child `child_qty_<parentId>_<childId>`
 * control whose total across a parent's children equals the parent's quantity. So
 * "is this listing active?" has two sources: page listings with `quantity_<id> >
 * 0`, and every child given a positive `child_qty_*` under an in-cart parent.
 * These helpers compute that effective set so the visibility/required scripts
 * drive off one definition. */

/** The numeric value of a quantity-style control (`quantity_<id>`,
 * `child_qty_*`), or 0 when absent/blank/invalid. A disabled control counts as 0
 * (a sold-out child can never be selected). */
export const controlQty = (
  control: HTMLSelectElement | HTMLInputElement | null,
): number => {
  if (control === null || control.disabled) return 0;
  // Strict: only a non-negative integer string is a quantity (mirrors the
  // server's child_qty parsing), so a tampered control value such as "2.9" or
  // "1abc" reads as 0, never a truncated quantity — no client/server drift.
  const raw = control.value.trim();
  return /^(0|[1-9]\d*)$/.test(raw) ? Number.parseInt(raw, 10) : 0;
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
  childQtyControls(parentId).reduce((total, c) => total + controlQty(c), 0);

/** The child ids with a positive chosen quantity under a parent. */
export const chosenChildIds = (parentId: string): Set<string> =>
  new Set(
    childQtyControls(parentId)
      .filter((control) => controlQty(control) > 0)
      .map((control) => childIdOf(parentId, control)),
  );

/** The id of a parent's SOLE auto-selected child, or null when the parent has
 * none (a multi-child parent uses `child_qty_*` controls instead). A parent with
 * a single bookable child emits an informational `data-sole-child` element with
 * NO `child_qty_*` control — the server fold auto-fills the whole parent quantity
 * to it (see `renderSoleChildOption`) — so the child is active whenever the parent
 * is in the cart even though no quantity control would report it (Fix 1). */
export const soleChildId = (parentId: string): string | null => {
  const sole = document.querySelector<HTMLElement>(
    `[data-sole-parent="${parentId}"]`,
  );
  return sole === null ? null : sole.getAttribute("data-sole-child");
};

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
 * Drives the question show/require machinery, so a child-only question is active
 * exactly when its child has a chosen quantity under an in-cart parent. */
export const selectedListingIds = (): Set<string> => {
  const ids = new Set<string>();
  for (const control of document.querySelectorAll<
    HTMLSelectElement | HTMLInputElement
  >('[name^="quantity_"]')) {
    const id = control.getAttribute("name")!.slice("quantity_".length);
    if (quantityValue(id) > 0) ids.add(id);
  }
  for (const parentId of childSelectorParentIds()) {
    if (!parentInCart(parentId)) continue;
    for (const childId of chosenChildIds(parentId)) ids.add(childId);
    // A sole auto-selected child has no `child_qty_*` control, so it is active
    // purely by virtue of the parent being in the cart (Fix 1).
    const sole = soleChildId(parentId);
    if (sole !== null) ids.add(sole);
  }
  return ids;
};

/** Disable + zero a control, or re-enable it. When disabling clears a chosen
 * quantity, a `change` event is dispatched — the zeroing happens in code, not via
 * the buyer, so dependent enhancement scripts (child-required, question-visibility,
 * running total) must be told to recompute against the now-removed selection. The
 * event fires only when a quantity was actually cleared (a re-enable, or disabling
 * an already-zero control, doesn't alter the selection). */
export const setControlDisabled = (
  control: HTMLSelectElement | HTMLInputElement,
  disabled: boolean,
): void => {
  if (!disabled) {
    control.disabled = false;
    return;
  }
  const hadQuantity = control.value !== "0";
  control.disabled = true;
  control.value = "0";
  if (hadQuantity) {
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
};

/** Add a `change` listener to every control matching `selector`. */
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
 * page has no child selector, otherwise run `perParent` for every parent id on
 * each change `register` reports (and once immediately). `initChildRequired` and
 * `initChildCompat` differ only in `register` (which controls drive the update)
 * and `perParent` (what they toggle). */
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
