/// <reference lib="dom" />
/** Question visibility: show custom questions only when at least one
 * associated listing has quantity > 0. A question is a radio <fieldset> or a
 * select <label>, both tagged .custom-question. Questions without
 * data-listing-ids are always visible (single-listing pages). */
export const initQuestionVisibility = (): void => {
  const questionFields = document.querySelectorAll<HTMLElement>(
    ".custom-question[data-listing-ids]",
  );
  if (questionFields.length === 0) return;

  const updateVisibility = () => {
    for (const field of Array.from(questionFields)) {
      const listingIds = (field.dataset.listingIds ?? "").split(" ");
      const hasSelected = listingIds.some((id: string) => {
        const qty = document.querySelector<
          HTMLSelectElement | HTMLInputElement
        >(`[name="quantity_${id}"]`);
        return qty !== null && Number.parseInt(qty.value, 10) > 0;
      });
      field.hidden = !hasSelected;
      // A select question is a single required control; radios are a required
      // group. Either way, drop `required` while the question is hidden so a
      // collapsed control can't silently block form submission.
      for (const control of Array.from(
        field.querySelectorAll('input[type="radio"], select'),
      ) as Array<HTMLInputElement | HTMLSelectElement>) {
        control.required = hasSelected;
      }
    }
  };
  // Listen on any quantity change
  for (const qty of Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '[name^="quantity_"]',
    ),
  )) {
    qty.addEventListener("change", updateVisibility);
  }
  // Run on load to set initial state
  updateVisibility();
};
