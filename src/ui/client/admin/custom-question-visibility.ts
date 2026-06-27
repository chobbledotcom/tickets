/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Question visibility: show custom questions only when at least one
 * associated listing is active. Questions are tagged .custom-question.
 * Questions without data-listing-ids are always visible (single-listing pages).
 *
 * "Active" includes folded children: a question whose data-listing-ids names a
 * child listing id is shown/required when that child is the selected child of an
 * in-cart parent (see selectedListingIds). The server enforces requiredness for
 * the chosen child only; this mirrors it in-browser so the buyer sees the field
 * they must fill. */
import { onSelectionChange, selectedListingIds } from "./child-selection.ts";

export const initQuestionVisibility = (): void => {
  const questionFields = document.querySelectorAll<HTMLElement>(
    ".custom-question[data-listing-ids]",
  );
  if (questionFields.length === 0) return;

  const updateVisibility = () => {
    const active = selectedListingIds();
    for (const field of questionFields) {
      const listingIds = field.dataset.listingIds!.split(" ");
      const hasSelected = listingIds.some((id) => active.has(id));
      field.hidden = !hasSelected;
      // Drop `required` while the question is hidden so a collapsed control
      // can't silently block form submission.
      for (const control of field.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >('input[type="radio"], input[type="text"], textarea, select')) {
        control.required = hasSelected;
      }
    }
  };
  // Re-run whenever a quantity or per-parent child selection changes.
  onSelectionChange(updateVisibility);
  // Run on load to set initial state
  updateVisibility();
};
