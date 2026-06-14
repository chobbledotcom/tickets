/// <reference lib="dom" />
/** Question visibility: show custom questions only when at least one
 * associated listing has quantity > 0. Questions without data-listing-ids are
 * always visible (single-listing pages). */
export const initQuestionVisibility = (): void => {
  const questionFields = document.querySelectorAll<HTMLFieldSetElement>(
    "fieldset.custom-question[data-listing-ids]",
  );
  if (questionFields.length === 0) return;

  const updateVisibility = () => {
    for (const fieldset of questionFields) {
      const listingIds = (fieldset.dataset.listingIds ?? "").split(" ");
      const hasSelected = listingIds.some((id) => {
        const qty = document.querySelector<
          HTMLSelectElement | HTMLInputElement
        >(`[name="quantity_${id}"]`);
        return qty !== null && Number.parseInt(qty.value, 10) > 0;
      });
      fieldset.hidden = !hasSelected;
      for (const radio of fieldset.querySelectorAll<HTMLInputElement>(
        'input[type="radio"]',
      )) {
        radio.required = hasSelected;
      }
    }
  };
  // Listen on any quantity change
  for (const qty of document.querySelectorAll<
    HTMLSelectElement | HTMLInputElement
  >('[name^="quantity_"]')) {
    qty.addEventListener("change", updateVisibility);
  }
  // Run on load to set initial state
  updateVisibility();
};
