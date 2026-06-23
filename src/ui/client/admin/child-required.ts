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
  childSelectorParentIds,
  chosenChildIds,
  onSelectionChange,
  parentInCart,
  quantityValue,
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

/** Apply `required` to one parent's pay-more price inputs for the current
 * selection and refresh its hint. */
const updateParent = (parentId: string): void => {
  const inCart = parentInCart(parentId);
  const chosen = chosenChildIds(parentId);
  for (const price of document.querySelectorAll<HTMLInputElement>(
    `[name^="child_price_${parentId}_"]`,
  )) {
    const childId = price
      .getAttribute("name")!
      .slice(`child_price_${parentId}_`.length);
    price.required = inCart && chosen.has(childId);
  }
  updateHint(parentId, inCart ? childQtyTotal(parentId) : 0);
};

export const initChildRequired = (): void => {
  const parentIds = childSelectorParentIds();
  if (parentIds.length === 0) return;

  const update = (): void => {
    for (const parentId of parentIds) updateParent(parentId);
  };
  onSelectionChange(update);
  update();
};
