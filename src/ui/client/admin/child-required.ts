/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Re-require the selected child's own inputs in the browser.
 *
 * The no-JS baseline renders every child control non-required (the server
 * enforces requiredness for the selected child of an in-cart parent only). With
 * JS we tighten it for inline feedback: for an in-cart parent the child radio
 * group becomes required, and only the *selected* pay-more child's price input
 * carries `required`. A zero-quantity parent relaxes all of its child controls
 * so it can never block a buyer booking a different listing. */
import {
  childSelectorParentIds,
  onSelectionChange,
  parentInCart,
} from "./child-selection.ts";

/** The radios of a parent's `child_<parentId>` group. */
const childRadios = (parentId: string): HTMLInputElement[] => [
  ...document.querySelectorAll<HTMLInputElement>(
    `input[name="child_${parentId}"]`,
  ),
];

/** Apply `required` to one parent's child controls for the current selection. */
const updateParent = (parentId: string): void => {
  const inCart = parentInCart(parentId);
  const radios = childRadios(parentId);
  // A child must be chosen for an in-cart parent (one is auto-checked).
  for (const radio of radios) radio.required = inCart;
  // The selected child's value drives which pay-more price input is required.
  const selected = radios.find((radio) => radio.checked)?.value;
  for (const price of document.querySelectorAll<HTMLInputElement>(
    `[name^="child_price_${parentId}_"]`,
  )) {
    const childId = price
      .getAttribute("name")!
      .slice(`child_price_${parentId}_`.length);
    price.required = inCart && childId === selected;
  }
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
