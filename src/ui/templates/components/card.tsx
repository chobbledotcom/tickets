/**
 * The shared media-card body: an optional image on top, then a body column
 * with the item's name and any detail lines. Wrappers choose the element —
 * the order gallery wraps it in a selectable `<label class="card order-card">`
 * and the news list in an `<a class="card news-card">` — so the layout CSS
 * (`.card`, `.card-image`, `.card-body`, `.card-name`) lives once.
 */

import { escapeHtml } from "#shared/jsx/escape-html.ts";

/** The grid both card collections sit in (`.card-grid` in the stylesheet). */
export const CARD_GRID_CLASS = "card-grid";

export const cardInner = (parts: {
  imageHtml: string;
  name: string;
  detailHtml: string;
}): string =>
  `${parts.imageHtml}
      <span class="card-body">
        <span class="card-name">${escapeHtml(parts.name)}</span>
        ${parts.detailHtml}
      </span>`;
