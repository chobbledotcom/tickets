/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Duplicate-group preview: re-renders the preview table live as the admin
 * types into the form. Uses the same buildDuplicatePreview helper that the
 * server uses when actually performing the duplication, so the preview is
 * guaranteed to match the result.
 */

import {
  buildDuplicatePreview,
  type DuplicateReplacements,
  formatIsoForPreview,
  type PreviewableListing,
} from "#shared/bulk-replace.ts";

export const initDuplicatePreview = (): void => {
  const container = document.querySelector<HTMLElement>(
    "[data-duplicate-preview]",
  );
  const dataEl = document.getElementById("duplicate-preview-listings");
  const tbody = document.querySelector<HTMLTableSectionElement>(
    "[data-duplicate-preview-rows]",
  );
  if (!container || !dataEl || !tbody) return;

  const listings: PreviewableListing[] = JSON.parse(dataEl.textContent ?? "[]");
  const tz = container.dataset.timezone ?? "UTC";
  const fieldVal = (name: string): string =>
    container.querySelector<HTMLInputElement>(
      `[data-duplicate-field="${name}"]`,
    )?.value ?? "";

  const renderPreview = () => {
    const replacements: DuplicateReplacements = {
      dateFind: fieldVal("date_find"),
      dateReplace: fieldVal("date_replace"),
      nameFind: fieldVal("name_find"),
      nameReplace: fieldVal("name_replace"),
    };
    const rows = buildDuplicatePreview(listings, replacements);
    tbody.innerHTML = rows
      .map((row) => {
        const td = (cls: string, text: string) =>
          `<td data-preview-${cls}>${text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</td>`;
        return (
          `<tr data-listing-id="${row.id}">` +
          td("original-name", row.originalName) +
          td("new-name", row.newName) +
          td("original-date", formatIsoForPreview(row.originalDate, tz)) +
          td("new-date", formatIsoForPreview(row.newDate, tz)) +
          "</tr>"
        );
      })
      .join("");
  };

  for (const input of container.querySelectorAll<HTMLInputElement>(
    "[data-duplicate-field]",
  )) {
    input.addEventListener("input", renderPreview);
  }
};
