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

/** Create a hidden form input carrying its name and value. */
export const createHiddenInput = (
  name: string,
  value: string,
): HTMLInputElement => {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  return input;
};

/** Create a thumbnail picture, with its loading hint and no alt text. */
export const createThumbnail = (
  src: string,
  loading: "eager" | "lazy",
): HTMLImageElement => {
  const image = document.createElement("img");
  image.alt = "";
  image.loading = loading;
  image.src = src;
  return image;
};

/** Find the CSRF token for the form an element belongs to. */
export const csrfTokenFor = (element: Element): string =>
  element
    .closest("form")
    ?.querySelector<HTMLInputElement>('input[name="csrfToken"]')?.value ?? "";

/** The one element under `root` that `selector` names. A missing element
 *  throws and names the selector, so a markup change fails where it starts. */
export const requiredChild = <TElement extends Element>(
  root: ParentNode,
  selector: string,
): TElement => {
  const element = root.querySelector<TElement>(selector);
  if (element === null) throw new Error(`Missing element: ${selector}`);
  return element;
};

/** Copy a complete template subtree into the current document. */
export const cloneContent = <T extends Node>(node: T): T =>
  document.importNode(node, true);

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
