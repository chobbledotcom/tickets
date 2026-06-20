/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Navigate to selected option value on change. */
export const initNavSelect = (): void => {
  for (const el of document.querySelectorAll<HTMLSelectElement>(
    "[data-nav-select]",
  )) {
    el.addEventListener("change", () => {
      location.href = el.value;
    });
  }
};
