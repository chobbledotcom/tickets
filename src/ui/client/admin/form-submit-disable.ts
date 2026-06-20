/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Disable form controls on submit to prevent double-submission, and re-enable
 * them when the page is restored from bfcache (back/forward navigation).
 *
 * Uses requestAnimationFrame so the browser sends the form before disabling.
 * Skips the manual check-in form which handles its own submission. */
export const initFormSubmitDisable = (): void => {
  for (const form of document.querySelectorAll<HTMLFormElement>(
    'form[method="POST"]:not([data-manual-checkin])',
  )) {
    form.addEventListener("submit", (listing) => {
      requestAnimationFrame(() => {
        if (listing.defaultPrevented) return;
        for (let i = 0; i < form.elements.length; i++) {
          (form.elements[i] as HTMLInputElement | HTMLButtonElement).disabled =
            true;
        }
      });
    });
  }

  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    for (const el of document.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("form[method='POST'] :disabled")) {
      el.disabled = false;
    }
  });
};
