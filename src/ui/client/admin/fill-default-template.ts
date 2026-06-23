/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Fill default template: clicking "Edit default template" fills the textarea
 * from its data-default-tpl attribute when the textarea is empty. */
export const initFillDefaultTemplate = (): void => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    "[data-fill-default]",
  )) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const ta = document.getElementById(
        link.dataset.fillDefault!,
      ) as HTMLTextAreaElement | null;
      if (ta && !ta.value) {
        ta.value = ta.dataset.defaultTpl ?? "";
        ta.focus();
      }
    });
  }
};
