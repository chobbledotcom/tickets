/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Re-require the selected children's price inputs and show a live "X of Q
 * chosen" hint in the browser (per-unit selection model).
 *
 * The no-JS baseline renders every child control non-required (the server
 * enforces the per-parent total and each chosen child's price). With JS we
 * tighten it for inline feedback: for an in-cart parent only the price inputs of
 * children given a positive `child_qty_*` carry `required`, and a per-parent hint
 * shows how many add-ons have been chosen out of the parent's quantity. A
 * zero-quantity parent relaxes all of its child controls so it can never block a
 * buyer booking a different listing. */
import {
  childQtyTotal,
  chosenChildIds,
  initParentSelectors,
  onSelectionChange,
  parentInCart,
  quantityValue,
  soleChildId,
} from "./child-selection.ts";

/** Update the per-parent "X of Q chosen" hint, when one is rendered. */
const updateHint = (parentId: string, chosen: number): void => {
  const hint = document.querySelector<HTMLElement>(
    `[data-child-hint="${parentId}"]`,
  );
  if (hint === null) return;
  hint.textContent = parentInCart(parentId)
    ? `${chosen} / ${quantityValue(parentId)}`
    : "";
};

/** The child ids whose price input must be required for an in-cart parent: every
 * child given a positive `child_qty_*`, PLUS a SOLE auto-selected pay-more child
 * (Fix 2). A sole child has no `child_qty_*` control — it is auto-filled to the
 * parent quantity by the server fold — so `chosenChildIds` never reports it, yet
 * its price IS collected and the fold rejects a blank one. Including it here
 * re-requires its price whenever the parent is in the cart. */
const requiredChildIds = (parentId: string): Set<string> => {
  const chosen = chosenChildIds(parentId);
  const sole = soleChildId(parentId);
  if (sole !== null) chosen.add(sole);
  return chosen;
};

/** Apply `required` to one parent's pay-more price inputs for the current
 * selection and refresh its hint. */
const updateParent = (parentId: string): void => {
  const inCart = parentInCart(parentId);
  const required = requiredChildIds(parentId);
  for (const price of document.querySelectorAll<HTMLInputElement>(
    `[name^="child_price_${parentId}_"]`,
  )) {
    const childId = price
      .getAttribute("name")!
      .slice(`child_price_${parentId}_`.length);
    price.required = inCart && required.has(childId);
  }
  updateHint(parentId, inCart ? childQtyTotal(parentId) : 0);
};

export const initChildRequired = (): void =>
  initParentSelectors(onSelectionChange, updateParent);
