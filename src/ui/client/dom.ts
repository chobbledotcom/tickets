/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Tiny browser-side DOM helpers shared by the hand-built client widgets (the
 * order cart, the markdown toolbar). Kept dependency-free so it can be bundled
 * into any client entry point.
 */

/** Create a `<button type="button">` with the given class, ready to fill in. */
export const createButton = (className: string): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  return button;
};

/** Run `setUp` for every element in the document that matches `selector`.
 *  Every widget on a page starts this way: find the marked elements, then
 *  enhance each one. */
export const forEachMatch = <TElement extends Element>(
  selector: string,
  setUp: (element: TElement) => void,
): void => {
  for (const element of document.querySelectorAll<TElement>(selector)) {
    setUp(element);
  }
};
