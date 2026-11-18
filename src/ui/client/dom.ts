/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Tiny browser-side DOM helpers shared by the hand-built client widgets (the
 * order cart, the markdown toolbar). Kept dependency-free so it can be bundled
 * into any client entry point.
 */

/** Create an element of the given tag with the given class, ready to fill in. */
export const createElementWithClass = (
  tag: string,
  className: string,
): HTMLElement => {
  const element = document.createElement(tag);
  element.className = className;
  return element;
};

/** Create a `<button type="button">` with the given class, ready to fill in. */
export const createButton = (className: string): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  return button;
};

/** Find the CSRF token for the form an element belongs to. */
export const csrfTokenFor = (element: Element): string =>
  element
    .closest("form")
    ?.querySelector<HTMLInputElement>('input[name="csrfToken"]')?.value ?? "";

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

/** Set an element's text and give the element back, for one-expression trees. */
export const setText = (element: HTMLElement, text: string): HTMLElement => {
  element.textContent = text;
  return element;
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
