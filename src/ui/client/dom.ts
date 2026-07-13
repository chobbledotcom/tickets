/// <reference lib="dom" />
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

/** Run `fn` for every `<a>` in the document that matches `selector`. */
export const forEachAnchor = (
  selector: string,
  fn: (link: HTMLAnchorElement) => void,
): void => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(selector)) {
    fn(link);
  }
};
