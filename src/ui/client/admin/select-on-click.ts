/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Auto-select input contents when clicked. */
export const initSelectOnClick = (): void => {
  for (const el of document.querySelectorAll<HTMLInputElement>(
    "[data-select-on-click]",
  )) {
    el.addEventListener("click", () => el.select());
  }
};
