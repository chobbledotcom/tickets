/// <reference lib="dom" />
/** Auto-select input contents when clicked. */
export const initSelectOnClick = (): void => {
  for (const el of Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-select-on-click]"),
  )) {
    el.addEventListener("click", () => el.select());
  }
};
